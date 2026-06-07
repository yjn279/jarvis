import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  type ThreadChannel,
  type Message,
  type MessageComponentInteraction,
} from "discord.js";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { splitText } from "./discord.js";

// ---------------------------------------------------------------------------
// Interactive control bridge (#2)
//
// Claude Code の3つの対話フロー（許可プロンプト・AskUserQuestion・プラン承認）を
// Discord ネイティブ UI（ボタン／セレクトメニュー）として描画し、ユーザーの選択を
// SDK の `canUseTool` の戻り値へ橋渡しする。生 stream-json では許可が自動拒否され
// 対話化できなかった制約（旧 docs/interactive-ui.md）を、SDK の canUseTool で解消する。
// ---------------------------------------------------------------------------

const DISCORD_MAX = 2000;

/** ブリッジ全体で共有する対話コンテキスト。 */
interface BridgeContext {
  thread: ThreadChannel;
  /** 操作を許可するユーザー ID（空＝全員）。shouldHandle と同じアクセス方針。 */
  allowUserIds: readonly string[];
  /** ボタン／セレクトの応答待ちタイムアウト（ミリ秒）。 */
  timeoutMs: number;
}

/** 個々のレンダラへ渡す実行時オプション（canUseTool の options から取り出す）。 */
interface RenderOptions {
  signal: AbortSignal;
  /** 「常に許可」を選んだとき updatedPermissions として返す権限更新案。 */
  suggestions?: PermissionUpdate[];
}

// ---------------------------------------------------------------------------
// Pure helpers (Discord-free — exported for unit testing)
// ---------------------------------------------------------------------------

/** Discord の各種ラベル上限に合わせて文字列を切り詰める（末尾に … を付す）。 */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 許可プロンプトの本文を toolName + input から組み立てる。
 * 実機検証では headless の canUseTool に `title` が渡らない（undefined）ため、
 * ツールごとに人間が読める日本語の説明を自前で生成する。
 */
export function describeTool(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path);
  switch (toolName) {
    case "Write":
      return `📝 ファイルを作成／上書きします: \`${truncate(path, 200)}\``;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `✏️ ファイルを編集します: \`${truncate(path, 200)}\``;
    case "Read":
      return `📖 ファイルを読み取ります: \`${truncate(path, 200)}\``;
    case "Bash": {
      const cmd = str(input.command);
      return `💻 コマンドを実行します:\n\`\`\`sh\n${truncate(cmd, 800)}\n\`\`\``;
    }
    case "WebFetch":
      return `🌐 URL を取得します: \`${truncate(str(input.url), 300)}\``;
    case "WebSearch":
      return `🔎 Web を検索します: \`${truncate(str(input.query), 300)}\``;
    default: {
      const preview = truncate(JSON.stringify(input), 400);
      return `🔧 \`${toolName}\` を実行します: \`${preview}\``;
    }
  }
}

/** AskUserQuestion の input から questions 配列を安全に取り出す。 */
export interface UserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export function parseQuestions(input: Record<string, unknown>): UserQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is UserQuestion => {
      return (
        typeof q === "object" && q !== null &&
        typeof (q as UserQuestion).question === "string" &&
        Array.isArray((q as UserQuestion).options)
      );
    })
    .map((q) => ({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options: q.options.filter((o) => o && typeof o.label === "string"),
      multiSelect: Boolean(q.multiSelect),
    }));
}

// ---------------------------------------------------------------------------
// Discord component plumbing
// ---------------------------------------------------------------------------

/** 0/未指定を「無制限」として扱う time オプションを組み立てる（中断シグナルで打ち切る前提）。 */
function timeOption(timeoutMs: number): { time?: number } {
  return timeoutMs > 0 ? { time: timeoutMs } : {};
}

/**
 * 1個のボタン操作を、allowlist フィルタ・タイムアウト・中断シグナルのいずれかで決着させる。
 * クリックされた interaction、または null（タイムアウト/中断）を返す。
 *
 * Collector を使い、中断時は `collector.stop()` で待受を確実に破棄する（awaitMessageComponent では
 * 中断時に内部 collector が time まで残り、time=0（無制限）だと永久にリークするため）。
 */
function awaitComponent(
  message: Message,
  ctx: BridgeContext,
  signal: AbortSignal,
): Promise<MessageComponentInteraction | null> {
  const filter = (i: MessageComponentInteraction): boolean =>
    ctx.allowUserIds.length === 0 || ctx.allowUserIds.includes(i.user.id);

  return new Promise((resolve) => {
    const collector = message.createMessageComponentCollector({
      filter,
      componentType: ComponentType.Button,
      max: 1,
      ...timeOption(ctx.timeoutMs),
    });
    const onAbort = (): void => collector.stop("abort");
    collector.once("end", (collected) => {
      signal.removeEventListener("abort", onAbort);
      resolve((collected.first() as MessageComponentInteraction | undefined) ?? null);
    });
    // 先にリスナを登録してから aborted を確認し、登録前後どちらの中断も取りこぼさない。
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) collector.stop("abort");
  });
}

/** 許可プロンプト（許可／常に許可／拒否）を描画して PermissionResult を返す。 */
async function renderPermission(
  ctx: BridgeContext,
  toolName: string,
  input: Record<string, unknown>,
  opts: RenderOptions,
): Promise<PermissionResult> {
  const desc = describeTool(toolName, input);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("allow").setLabel("許可").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("always").setLabel("常に許可").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("deny").setLabel("拒否").setStyle(ButtonStyle.Danger),
  );
  const msg = await ctx.thread.send({ content: truncate(`🔐 **許可の確認**\n${desc}`, DISCORD_MAX), components: [row] });

  const i = await awaitComponent(msg, ctx, opts.signal);
  if (!i) {
    await msg.edit({ content: `🔐 **許可の確認**\n${desc}\n\n⌛ 応答が無かったため拒否しました。`, components: [] }).catch(() => {});
    return { behavior: "deny", message: "ユーザーが時間内に応答しなかったため拒否しました。" };
  }

  const label = i.customId === "deny" ? "⛔ 拒否" : i.customId === "always" ? "✅ 常に許可" : "✅ 許可";
  await i.update({ content: `🔐 ${desc}\n\n${label}`, components: [] }).catch(() => {});

  // 許可結果には必ず updatedInput を含める。これを省くと SDK の許可応答スキーマが
  // ZodError（Invalid input）で弾き、ツールが実行されず「許可したのに何も起きない」
  // 状態になる（実機検証で確認）。元の input をそのまま返す。
  if (i.customId === "deny") return { behavior: "deny", message: "ユーザーが拒否しました。" };
  if (i.customId === "always") {
    return { behavior: "allow", updatedInput: input, updatedPermissions: opts.suggestions ?? [] };
  }
  return { behavior: "allow", updatedInput: input };
}

/** AskUserQuestion を1メッセージ複数セレクトメニューで描画し、回答を answers として返す。 */
async function renderQuestions(
  ctx: BridgeContext,
  input: Record<string, unknown>,
  opts: RenderOptions,
): Promise<PermissionResult> {
  const questions = parseQuestions(input);
  const renderable = questions.filter((q) => q.options.length > 0).slice(0, 5); // Discord は1メッセージ最大5行
  if (renderable.length === 0) {
    return { behavior: "deny", message: "提示できる選択肢が無いため質問をスキップしました。" };
  }

  const rows = renderable.map((q, idx) => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`q${idx}`)
      .setPlaceholder(truncate(q.header ?? q.question, 100))
      .addOptions(
        q.options.slice(0, 25).map((o) => ({
          label: truncate(o.label, 100),
          value: truncate(o.label, 100),
          ...(o.description ? { description: truncate(o.description, 100) } : {}),
        })),
      );
    if (q.multiSelect) menu.setMinValues(1).setMaxValues(Math.min(q.options.length, 25));
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  });

  const heading = renderable.map((q, i) => `**${i + 1}. ${q.question}**`).join("\n");
  const msg = await ctx.thread.send({ content: truncate(`❓ **質問**\n${heading}`, DISCORD_MAX), components: rows });

  const filter = (i: MessageComponentInteraction): boolean =>
    ctx.allowUserIds.length === 0 || ctx.allowUserIds.includes(i.user.id);
  const answers: Record<string, string | string[]> = {};
  const collector = msg.createMessageComponentCollector({
    filter,
    componentType: ComponentType.StringSelect,
    ...timeOption(ctx.timeoutMs),
  });

  await new Promise<void>((resolve) => {
    const onAbort = (): void => collector.stop("abort");
    collector.on("collect", (i) => {
      const idx = Number(i.customId.slice(1));
      const q = renderable[idx];
      if (q) answers[q.question] = q.multiSelect ? i.values : (i.values[0] ?? "");
      void i.deferUpdate().catch(() => {});
      if (Object.keys(answers).length >= renderable.length) collector.stop("done");
    });
    collector.on("end", () => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve();
    });
    // 先にリスナを登録してから aborted を確認し、登録前後どちらの中断も取りこぼさない。
    opts.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.signal.aborted) collector.stop("abort");
  });

  if (Object.keys(answers).length < renderable.length) {
    await msg.edit({ content: `❓ **質問**\n${heading}\n\n⌛ 回答が揃わなかったため取り消しました。`, components: [] }).catch(() => {});
    return { behavior: "deny", message: "ユーザーが時間内に回答しませんでした。" };
  }

  const summary = renderable
    .map((q, i) => {
      const a = answers[q.question];
      return `**${q.header ?? `Q${i + 1}`}**: ${Array.isArray(a) ? a.join(", ") : a}`;
    })
    .join("\n");
  await msg.edit({ content: truncate(`❓ **回答**\n${summary}`, DISCORD_MAX), components: [] }).catch(() => {});

  return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
}

/** ExitPlanMode の計画を描画し、承認（自動実行へ移行）／却下を返す。 */
async function renderPlan(
  ctx: BridgeContext,
  input: Record<string, unknown>,
  opts: RenderOptions,
  state: { acceptEdits: boolean },
): Promise<PermissionResult> {
  const plan = typeof input.plan === "string" ? input.plan : "";
  for (const chunk of splitText(`📋 **実行計画**\n\n${plan}`)) {
    await ctx.thread.send(chunk).catch(() => {});
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("approve").setLabel("承認して実行").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("reject").setLabel("却下").setStyle(ButtonStyle.Danger),
  );
  const msg = await ctx.thread.send({ content: "📋 この計画で実行しますか？", components: [row] });

  const i = await awaitComponent(msg, ctx, opts.signal);
  if (!i) {
    await msg.edit({ content: "📋 ⌛ 応答が無かったため計画を却下しました（計画モードを継続します）。", components: [] }).catch(() => {});
    return { behavior: "deny", message: "ユーザーが時間内に応答しなかったため計画を却下しました。計画モードを継続してください。" };
  }
  if (i.customId === "approve") {
    await i.update({ content: "📋 ✅ 計画を承認しました。実行します。", components: [] }).catch(() => {});
    // 承認後は編集ツールをブリッジ側で自動許可し、実行中の逐次プロンプトでスレッドを埋めない。
    // SDK の setMode(acceptEdits) は canUseTool を抑止しない（実機検証で確認）ため、state で代替する。
    // updatedInput を省くと許可応答スキーマが ZodError で弾くため、元の input を返す（renderPermission と同じ）。
    state.acceptEdits = true;
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    };
  }
  await i.update({ content: "📋 ✏️ 計画を却下しました。修正します。", components: [] }).catch(() => {});
  return { behavior: "deny", message: "ユーザーは計画を承認しませんでした。フィードバックを踏まえて計画を見直してください。" };
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

/** 計画承認後に無確認で自動許可する編集ツール。Bash 等は対象外＝引き続き確認する。 */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * スレッドに束ねた `canUseTool` ブリッジを生成する（#2 の中核）。
 * AskUserQuestion・ExitPlanMode・通常の許可をそれぞれの Discord UI へ振り分ける。
 *
 * 計画承認後は acceptEdits 相当に切り替える。SDK の setMode(acceptEdits) は canUseTool を
 * 抑止しないため（実機検証で確認）、ブリッジ単位の state で編集ツールを無確認許可し、
 * 実行中の逐次プロンプトでスレッドを埋めないようにする。state はスレッド（このブリッジ）に
 * 閉じるため、別スレッドの承認状態と混ざらない。
 */
export function makePermissionBridge(ctx: BridgeContext): CanUseTool {
  const state = { acceptEdits: false };
  return async (toolName, input, options): Promise<PermissionResult> => {
    const render: RenderOptions = { signal: options.signal, suggestions: options.suggestions };
    try {
      if (toolName === "AskUserQuestion") return await renderQuestions(ctx, input, render);
      if (toolName === "ExitPlanMode") return await renderPlan(ctx, input, render, state);
      // 計画承認後は編集ツールを無確認で自動許可する（Bash 等は引き続き確認）。
      if (state.acceptEdits && EDIT_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
      return await renderPermission(ctx, toolName, input, render);
    } catch (err) {
      // UI 描画・待受の想定外失敗は安全側（拒否）に倒す。
      console.error("対話 UI の描画に失敗:", err);
      return { behavior: "deny", message: "対話 UI の表示に失敗したため拒否しました。" };
    }
  };
}
