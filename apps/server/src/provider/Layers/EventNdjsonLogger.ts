/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a workspace-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 */
import fs from "node:fs";
import path from "node:path";

import type { WorkspaceId } from "@matcha/contracts";
import { RotatingFileSink } from "@matcha/shared/logging";
import { Effect, Exit, Logger, Scope, SynchronizedRef } from "effect";

import { toSafeWorkspaceAttachmentSegment } from "../../attachmentStore.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 200;
const GLOBAL_WORKSPACE_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, workspaceId: WorkspaceId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
}

interface WorkspaceWriter {
  writeMessage: (message: string) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

interface LoggerState {
  readonly workspaceWriters: Map<string, WorkspaceWriter>;
  readonly failedSegments: Set<string>;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveWorkspaceSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeWorkspaceAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_WORKSPACE_SEGMENT;
}

function formatLoggerMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  }
  return typeof message === "string" ? message : String(message);
}

function makeLineLogger(streamLabel: string): Logger.Logger<unknown, string> {
  return Logger.make(
    ({ date, message }) =>
      `[${date.toISOString()}] ${streamLabel}: ${formatLoggerMessage(message)}\n`,
  );
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

const toLogMessage = Effect.fn("toLogMessage")(function* (
  event: unknown,
): Effect.fn.Return<string | undefined> {
  const serialized = yield* Effect.sync(() => {
    try {
      return { ok: true as const, value: JSON.stringify(event) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!serialized.ok) {
    yield* logWarning("failed to serialize provider event log record", {
      error: serialized.error,
    });
    return undefined;
  }

  if (typeof serialized.value !== "string") {
    return undefined;
  }

  return serialized.value;
});

const makeWorkspaceWriter = Effect.fn("makeWorkspaceWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly streamLabel: string;
}): Effect.fn.Return<WorkspaceWriter | undefined> {
  const sinkResult = yield* Effect.sync(() => {
    try {
      return {
        ok: true as const,
        sink: new RotatingFileSink({
          filePath: input.filePath,
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
          throwOnError: true,
        }),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  });

  if (!sinkResult.ok) {
    yield* logWarning("failed to initialize provider workspace log file", {
      filePath: input.filePath,
      error: sinkResult.error,
    });
    return undefined;
  }

  const sink = sinkResult.sink;
  const scope = yield* Scope.make();
  const lineLogger = makeLineLogger(input.streamLabel);
  const batchedLogger = yield* Logger.batched(lineLogger, {
    window: input.batchWindowMs,
    flush: Effect.fn("makeWorkspaceWriter.flush")(function* (messages) {
      const flushResult = yield* Effect.sync(() => {
        try {
          for (const message of messages) {
            sink.write(message);
          }
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      });

      if (!flushResult.ok) {
        yield* logWarning("provider event log batch flush failed", {
          filePath: input.filePath,
          error: flushResult.error,
        });
      }
    }),
  }).pipe(Effect.provideService(Scope.Scope, scope));

  const loggerLayer = Logger.layer([batchedLogger], { mergeWithExisting: false });

  return {
    writeMessage(message: string) {
      return Effect.log(message).pipe(Effect.provide(loggerLayer));
    },
    close() {
      return Scope.close(scope, Exit.void);
    },
  } satisfies WorkspaceWriter;
});

export const makeEventNdjsonLogger = Effect.fn("makeEventNdjsonLogger")(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const streamLabel = resolveStreamLabel(options.stream);

  const directoryReady = yield* Effect.sync(() => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return true;
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (directoryReady !== true) {
    yield* logWarning("failed to create provider event log directory", {
      filePath,
      error: directoryReady.error,
    });
    return undefined;
  }

  const stateRef = yield* SynchronizedRef.make<LoggerState>({
    workspaceWriters: new Map(),
    failedSegments: new Set(),
  });

  const resolveWorkspaceWriter = Effect.fn("resolveWorkspaceWriter")(function* (
    workspaceSegment: string,
  ): Effect.fn.Return<WorkspaceWriter | undefined> {
    return yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
      if (state.failedSegments.has(workspaceSegment)) {
        return Effect.succeed([undefined, state] as const);
      }

      const existing = state.workspaceWriters.get(workspaceSegment);
      if (existing) {
        return Effect.succeed([existing, state] as const);
      }

      return makeWorkspaceWriter({
        filePath: path.join(path.dirname(filePath), `${workspaceSegment}.log`),
        maxBytes,
        maxFiles,
        batchWindowMs,
        streamLabel,
      }).pipe(
        Effect.map((writer) => {
          if (!writer) {
            const nextFailedSegments = new Set(state.failedSegments);
            nextFailedSegments.add(workspaceSegment);
            return [
              undefined,
              {
                ...state,
                failedSegments: nextFailedSegments,
              },
            ] as const;
          }

          const nextWorkspaceWriters = new Map(state.workspaceWriters);
          nextWorkspaceWriters.set(workspaceSegment, writer);
          return [
            writer,
            {
              ...state,
              workspaceWriters: nextWorkspaceWriters,
            },
          ] as const;
        }),
      );
    });
  });

  const write = Effect.fn("write")(function* (event: unknown, workspaceId: WorkspaceId | null) {
    const workspaceSegment = resolveWorkspaceSegment(workspaceId);
    const message = yield* toLogMessage(event);
    if (!message) {
      return;
    }

    const writer = yield* resolveWorkspaceWriter(workspaceSegment);
    if (!writer) {
      return;
    }

    yield* writer.writeMessage(message);
  });

  const close = Effect.fn("close")(function* () {
    yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      Effect.gen(function* () {
        for (const writer of state.workspaceWriters.values()) {
          yield* writer.close();
        }

        return [
          undefined,
          {
            workspaceWriters: new Map<string, WorkspaceWriter>(),
            failedSegments: new Set<string>(),
          },
        ] as const;
      }),
    );
  });

  return {
    filePath,
    write,
    close,
  } satisfies EventNdjsonLogger;
});
