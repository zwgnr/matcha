import { type ProviderKind, type WorkspaceId } from "@matcha/contracts";
import { Effect, Layer, Option } from "effect";

import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderKind, ProviderSessionDirectoryPersistenceError> {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return Effect.succeed(providerName);
  }
  return Effect.fail(
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Unknown persisted provider '${providerName}'.`,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntimeRepository;

  const getBinding = (workspaceId: WorkspaceId) =>
    repository.getByWorkspaceId({ workspaceId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByWorkspaceId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            decodeProviderKind(value.providerName, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((provider) =>
                Option.some({
                  workspaceId: value.workspaceId,
                  provider,
                  adapterKey: value.adapterKey,
                  runtimeMode: value.runtimeMode,
                  status: value.status,
                  resumeCursor: value.resumeCursor,
                  runtimePayload: value.runtimePayload,
                }),
              ),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = Effect.fn(function* (binding) {
    const existing = yield* repository
      .getByWorkspaceId({ workspaceId: binding.workspaceId })
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByWorkspaceId")),
      );

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedWorkspaceId = binding.workspaceId ?? existingRuntime?.workspaceId;
    if (!resolvedWorkspaceId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "workspaceId must be a non-empty string.",
      });
    }

    const now = new Date().toISOString();
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    yield* repository
      .upsert({
        workspaceId: resolvedWorkspaceId,
        providerName: binding.provider,
        adapterKey:
          binding.adapterKey ??
          (providerChanged ? binding.provider : (existingRuntime?.adapterKey ?? binding.provider)),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
        status: binding.status ?? existingRuntime?.status ?? "running",
        lastSeenAt: now,
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : (existingRuntime?.resumeCursor ?? null),
        runtimePayload: mergeRuntimePayload(
          existingRuntime?.runtimePayload ?? null,
          binding.runtimePayload,
        ),
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (workspaceId) =>
    getBinding(workspaceId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for workspace '${workspaceId}'.`,
              }),
            ),
        }),
      ),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (workspaceId) =>
    repository
      .deleteByWorkspaceId({ workspaceId })
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteByWorkspaceId")),
      );

  const listWorkspaceIds: ProviderSessionDirectoryShape["listWorkspaceIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listWorkspaceIds:list")),
      Effect.map((rows) => rows.map((row) => row.workspaceId)),
    );

  return {
    upsert,
    getProvider,
    getBinding,
    remove,
    listWorkspaceIds,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}
