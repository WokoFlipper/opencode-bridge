/**
 * opencode-bridge plugin shim.
 * Maps opencode session lifecycle events to the claude-bridge-compatible
 * POST /hook payload so bridge/server.js can stay unchanged.
 *
 * Install: copy to ~/.config/opencode/plugin/opencode-bridge.ts
 * or <project>/.opencode/plugins/opencode-bridge.ts, then restart opencode.
 *
 * Env contract (set by keeper.js via server.js createSession):
 *   OPENCODE_BRIDGE_SESSION — bridge session id (s<seq>-<hex>)
 *   OPENCODE_BRIDGE_PORT    — bridge https port (default 8890)
 *
 * Security notes (mirrors bridge-hook.sh semantics):
 * - fire-and-forget, 2s timeout, errors swallowed: hook must never break the agent.
 * - only fires when OPENCODE_BRIDGE_SESSION is set (inside a bridge session).
 * - POSTs to loopback only (127.0.0.1), same as the original sh hook.
 */
import type { Plugin } from "@opencode-ai/plugin";

async function sendHook(hook_event_name: string, message: string): Promise<void> {
  // Env читаем в момент события: плагин может жить дольше одной сессии,
  // а OPENCODE_BRIDGE_SESSION выставляет keeper на каждую сессию отдельно.
  const sid = process.env.OPENCODE_BRIDGE_SESSION ?? "";
  if (!sid) return;
  const port = process.env.OPENCODE_BRIDGE_PORT ?? "8890";
  const url = `https://127.0.0.1:${port}/hook`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Session": sid,
      },
      body: JSON.stringify({ hook_event_name, message }),
      // self-signed bridge cert, loopback only — same trust as curl -sk in bridge-hook.sh
      // @ts-expect-error bun/openCode fetch flag for self-signed
      tls: { rejectUnauthorized: false },
      signal: ctrl.signal,
    } as RequestInit).catch(() => undefined);
    clearTimeout(t);
  } catch {
    // hook must never break the session
  }
}

const OpencodeBridge: Plugin = async () => {
  return {
    event: async ({ event }: { event: { type: string } & Record<string, unknown> }) => {
      switch (event.type) {
        case "session.idle":
          await sendHook("Stop", "opencode завершил ответ");
          break;
        case "session.status":
          // working ping — lets the bridge clear stale phone notifications,
          // mirrors server.js handling of UserPromptSubmit/PostToolUse
          await sendHook("UserPromptSubmit", "opencode работает");
          break;
        case "permission.asked":
        case "tui.toast.show":
          await sendHook("Notification", String((event as Record<string, unknown>).message ?? "opencode ждёт подтверждения"));
          break;
      }
    },
  };
};

export default OpencodeBridge;
