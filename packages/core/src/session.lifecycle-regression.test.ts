import { beforeEach, afterEach, expect, it, vi } from "vitest";

type TestSocket = import("node:events").EventEmitter & {
  readyState: number;
  send: import("vitest").Mock;
  close: import("vitest").Mock<() => void>;
};

const state = vi.hoisted(() => ({
  sockets: [] as TestSocket[],
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    send = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close"));
    });
    constructor(..._args: unknown[]) {
      super();
      state.sockets.push(this);
    }
  }
  return { default: FakeSocket };
});

vi.mock("./log.js", () => ({
  createLogger: () => ({
    info: state.info,
    error: state.error,
    debug: state.debug,
  }),
  trunc: (text: string, limit: number) => text.slice(0, limit),
  FRAME_DIR: "/synthetic-unused-frame-directory",
}));

vi.mock("./copilot.js", () => ({
  decodeJwt: () => ({
    oid: "synthetic-object",
    tid: "synthetic-tenant",
    aud: "synthetic-audience",
    iss: "synthetic-issuer",
    exp: 2000000000,
  }),
  getScenarioForModel: () => ({
    scenario: "SyntheticScenario",
    licenseType: "SyntheticLicence",
  }),
  getToneForModel: () => "SyntheticTone",
}));

vi.mock("./native-actions.js", () => ({
  parseActionConfirmation: () => null,
  buildResumeInvokeAction: () => {
    throw new Error("Action execution forbidden in this fixture");
  },
  shouldAutoConfirm: () => false,
  ACTION_ALLOWED_MESSAGE_TYPES: [],
}));

vi.mock("./priority-access.js", () => ({
  parseMetering: () => null,
  meteredAllowance: () => null,
  METERED_BUDGETS: {},
}));

vi.mock("node:fs", () => ({
  appendFileSync: () => {
    throw new Error("Frame writes forbidden in this fixture");
  },
  mkdirSync: () => {
    throw new Error("Directory creation forbidden in this fixture");
  },
}));

// Bind freshly imported modules to this suite's registered mocks.
vi.resetModules();
const { CopilotSession } = await import("./session.js");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  state.sockets = [];
  state.info.mockClear();
  state.error.mockClear();
  state.debug.mockClear();
  vi.stubEnv("M365_DUMP_FRAMES", "");
  vi.stubEnv("M365_EXTRA_OPTIONSSETS", "");
  vi.stubEnv("M365_EXTRA_VARIANTS", "");
});
afterEach(() => vi.unstubAllEnvs());

function start(signal?: AbortSignal) {
  const session = new CopilotSession();
  const pending = session.chat(
    "synthetic-token-not-a-credential",
    "Synthetic request.",
    "synthetic-model",
    signal,
  );
  let settled = false;
  const observed = pending.then(
    (stream) => {
      settled = true;
      return { stream, error: null };
    },
    (error: unknown) => {
      settled = true;
      return { stream: null, error };
    },
  );
  const socket = state.sockets.at(-1);
  expect(socket).toBeDefined();
  if (!socket) throw new Error("Expected a constructed test socket");
  return { socket, observed, isSettled: () => settled };
}

it("V4-033: clean pre-handshake close rejects promptly", async () => {
  const turn = start();
  turn.socket.close();
  await tick();
  expect(turn.isSettled()).toBe(true);
  const { error } = await turn.observed;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected an Error rejection");
  expect(error.message).toContain("before the chat request");
});

it("V4-034: pre-aborted chat rejects without constructing a socket", async () => {
  const controller = new AbortController();
  controller.abort();
  const session = new CopilotSession();
  await expect(
    session.chat("synthetic-token", "Synthetic request.", "synthetic-model", controller.signal),
  ).rejects.toBe(controller.signal.reason);
  expect(state.sockets).toHaveLength(0);
});

it("V4-034: abort prevents a late handshake from sending chat", async () => {
  const controller = new AbortController();
  const turn = start(controller.signal);
  controller.abort();
  await tick();
  expect(turn.isSettled()).toBe(true);
  expect((await turn.observed).error).toBe(controller.signal.reason);
  turn.socket.emit("open");
  turn.socket.emit("message", Buffer.from(`{}${String.fromCharCode(30)}`));
  expect(turn.socket.send).not.toHaveBeenCalled();
});

it("V4-034: synchronous chat-send failure rejects promptly", async () => {
  const turn = start();
  turn.socket.send.mockImplementation(() => {
    throw new Error("Synthetic send failure");
  });
  turn.socket.emit("message", Buffer.from(`{}${String.fromCharCode(30)}`));
  const { error } = await turn.observed;
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected an Error rejection");
  expect(error.message).toBe("Synthetic send failure");
});

it("logs transport failures with correlation and preserves rejection", async () => {
  const turn = start();
  turn.socket.emit("error", new Error("Synthetic transport failure"));
  const { error } = await turn.observed;
  expect(error).toBeInstanceOf(Error);
  expect(state.error).toHaveBeenCalledWith(
    expect.stringMatching(/WS error: request=.+ sid=.+ cid=.+/),
    "WebSocket error: Synthetic transport failure",
  );
  await tick();
  expect(state.info).toHaveBeenCalledWith(
    expect.stringMatching(/WS closed: request=.+ sid=.+ cid=.+.*answerLength=0.*quota=unknown/),
  );
  expect(state.debug).toHaveBeenCalledWith(expect.stringMatching(/Final response: request=.+/), "");
});

it.each([
  [7, "Server close"],
  [3, "Completion error"],
])("logs SignalR type %s errors and preserves stream rejection", async (type, label) => {
  const turn = start();
  const rs = String.fromCharCode(30);
  turn.socket.emit("message", Buffer.from(`{}${rs}`));
  const { stream } = await turn.observed;
  if (!stream) throw new Error("Expected a chat stream");
  const pending = stream[Symbol.asyncIterator]().next();
  turn.socket.emit(
    "message",
    Buffer.from(
      `${JSON.stringify({ type, invocationId: "0", error: "Synthetic upstream failure" })}${rs}`,
    ),
  );
  await expect(pending).rejects.toThrow(`${label}: Synthetic upstream failure`);
  expect(state.error).toHaveBeenCalledWith(
    expect.stringContaining(`${label}: request=`),
    "Synthetic upstream failure",
  );
  await tick();
});
