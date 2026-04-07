import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkspaceId } from "@matcha/contracts";
import { it, assert } from "@effect/vitest";
import { assertFailure, assertSome } from "@effect/vitest/utils";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes workspace bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initialWorkspaceId = WorkspaceId.makeUnsafe("workspace-1");

      yield* directory.upsert({
        provider: "codex",
        workspaceId: initialWorkspaceId,
      });

      const provider = yield* directory.getProvider(initialWorkspaceId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialWorkspaceId);
      assertSome(resolvedBinding, {
        workspaceId: initialWorkspaceId,
        provider: "codex",
      });
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.workspaceId, initialWorkspaceId);
      }

      const nextWorkspaceId = WorkspaceId.makeUnsafe("workspace-2");

      yield* directory.upsert({
        provider: "codex",
        workspaceId: nextWorkspaceId,
      });
      const updatedBinding = yield* directory.getBinding(nextWorkspaceId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.workspaceId, nextWorkspaceId);
      }

      const runtime = yield* runtimeRepository.getByWorkspaceId({ workspaceId: nextWorkspaceId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.workspaceId, nextWorkspaceId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
      }

      const workspaceIds = yield* directory.listWorkspaceIds();
      assert.deepEqual(workspaceIds, [nextWorkspaceId]);

      yield* directory.remove(nextWorkspaceId);
      const missingProvider = yield* directory.getProvider(nextWorkspaceId).pipe(Effect.result);
      assertFailure(
        missingProvider,
        new ProviderSessionDirectoryPersistenceError({
          operation: "ProviderSessionDirectory.getProvider",
          detail: `No persisted provider binding found for workspace '${nextWorkspaceId}'.`,
        }),
      );
    }));

  it("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const workspaceId = WorkspaceId.makeUnsafe("workspace-runtime");

      yield* directory.upsert({
        provider: "codex",
        workspaceId,
        status: "starting",
        resumeCursor: {
          workspaceId: "provider-workspace-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: "codex",
        workspaceId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByWorkspaceId({ workspaceId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.workspaceId, workspaceId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          workspaceId: "provider-workspace-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }));

  it("resets adapterKey to the new provider when provider changes without an explicit adapter key", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const workspaceId = WorkspaceId.makeUnsafe("workspace-provider-change");

      yield* runtimeRepository.upsert({
        workspaceId,
        providerName: "claudeAgent",
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });

      yield* directory.upsert({
        provider: "codex",
        workspaceId,
      });

      const runtime = yield* runtimeRepository.getByWorkspaceId({ workspaceId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.adapterKey, "codex");
      }
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matcha-provider-directory-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const workspaceId = WorkspaceId.makeUnsafe("workspace-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: "codex",
          workspaceId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(workspaceId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(workspaceId);
        assertSome(resolvedBinding, {
          workspaceId,
          provider: "codex",
        });
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.workspaceId, workspaceId);
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }));
});
