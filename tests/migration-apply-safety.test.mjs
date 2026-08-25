import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMigration } from "../work/migrate-csd-v022-to-sites.mjs";

const EXPECTED_TARGET = { parts: 120, stockRows: 124, rmaRecords: 5996, shipmentRows: 98 };
const SOURCE_SHA256 = "277391e3506146a71f7ff5dde803a647f5ebf8f024606f76e349938bff8099f3";

function deployedMigrationContract() {
  return {
    contractVersion: "csd-baseline-v022-1",
    applyPath: "/api/admin/migrations/v0.2.2",
    reconciliationPath: "/api/admin/migrations/v0.2.2/reconciliation",
    filename: "CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    maxBytes: 524288,
    sourceSha256: SOURCE_SHA256,
    expectedSource: EXPECTED_TARGET,
  };
}

function validReconciliation(overrides = {}) {
  return {
    migrationKey: "csd-v022-baseline",
    migrationVersion: "v0.2.2-baseline",
    sourceSha256: SOURCE_SHA256,
    versionId: 71,
    versionCode: "V260802",
    target: EXPECTED_TARGET,
    dashboard: {
      asOfDate: "2026-07-23",
      shortage_part_count: 5,
      shortage_qty: 137.1,
      in_transit_qty: 989,
      pending_production_qty: 0,
    },
    ...overrides,
  };
}

async function withPrivateDeploymentContract(endpoint, callback) {
  const directory = await mkdtemp(join(tmpdir(), "csd-private-deployment-"));
  const contractPath = join(directory, "private-deployment.json");
  await writeFile(contractPath, `${JSON.stringify({
    version: "csd-owner-only-v1",
    endpoint,
    privateAccess: { provider: "cloudflare-access", ownerOnly: true },
    unauthenticatedHealthCheck: { path: "/api/health", deniedStatuses: [401, 403] },
    migrationApi: { contractPath: "/api/admin/migrations/v0.2.2/contract" },
  })}\n`);
  try {
    await callback(contractPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function noNetworkFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error("network must not be called");
    },
  };
}

test("--apply rejects missing or unsafe endpoints before any network request", async () => {
  const blockedEndpoints = [
    undefined,
    "http://owner.csd.example",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://example.trycloudflare.com",
    "https://example.trycloudflare.com.",
  ];

  for (const endpoint of blockedEndpoints) {
    const network = noNetworkFetch();
    const args = ["--apply"];
    if (endpoint) args.push("--endpoint", endpoint, "--private-deployment-contract", "/not-read.json");
    await assert.rejects(
      runMigration({ args, fetchImpl: network.fetchImpl }),
      /--endpoint|HTTPS|localhost|IP|trycloudflare/i,
    );
    assert.equal(network.calls.length, 0, endpoint ?? "missing endpoint");
  }
});

test("--apply rejects an endpoint that is not the owner-only contract endpoint before network access", async () => {
  await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
    const network = noNetworkFetch();
    await assert.rejects(
      runMigration({
        args: ["--apply", "--endpoint", "https://untrusted.csd.example", "--private-deployment-contract", contractPath],
        fetchImpl: network.fetchImpl,
      }),
      /does not match/i,
    );
    assert.equal(network.calls.length, 0);
  });
});

test("--apply performs only the contract's unauthenticated private-access check and sends no write", async () => {
  await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
    const calls = [];
    const fetchImpl = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(null, { status: 403 });
    };

    await assert.rejects(
      runMigration({
        args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
        fetchImpl,
      }),
      /no authenticated baseline migration API|no writes were sent/i,
    );
    assert.deepEqual(calls, [{
      input: "https://owner.csd.example/api/health",
      init: { method: "GET", redirect: "manual" },
    }]);
  });
});

test("--apply sends the Sites bypass bearer in the private authorization header", async () => {
  await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
    const sourceBytes = await readFile("/Users/jesse/Desktop/CSD管理系統/CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx");
    const calls = [];
    const fetchImpl = async (input, init) => {
      calls.push({ input: String(input), init });
      if (calls.length === 1) return new Response(null, { status: 403 });
      if (calls.length === 2) return Response.json(deployedMigrationContract());
      if (calls.length === 3) return Response.json({
        version_id: 71,
        target: EXPECTED_TARGET,
        migration_version: "v0.2.2-baseline",
      }, { status: 201 });
      if (calls.length === 4) return Response.json(validReconciliation());
      throw new Error("unexpected request");
    };

    await runMigration({
      args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
      fetchImpl,
      ownerAuthorization: "owner-only-test-token",
      writeReportImpl: async () => {},
    });

    for (const call of calls.slice(1)) {
      assert.equal(call.init.headers["oai-sites-authorization"], "Bearer owner-only-test-token");
      assert.equal(Object.hasOwn(call.init.headers, "authorization"), false);
    }
    assert.deepEqual(Buffer.from(calls[2].init.body), sourceBytes);
  });
});

test("--apply checks the deployed migration contract, uploads only the fixed workbook, then writes reconciled output", async () => {
  await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
    const sourceBytes = await readFile("/Users/jesse/Desktop/CSD管理系統/CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx");
    const reportWrites = [];
    const calls = [];
    const fetchImpl = async (input, init) => {
      calls.push({ input: String(input), init });
      if (calls.length === 1) return new Response(null, { status: 403 });
      if (calls.length === 2) return Response.json(deployedMigrationContract());
      if (calls.length === 3) return Response.json({
        version_id: 71,
        target: EXPECTED_TARGET,
        migration_version: "v0.2.2-baseline",
      }, { status: 201 });
      if (calls.length === 4) return Response.json(validReconciliation());
      throw new Error("unexpected request");
    };

    const report = await runMigration({
      args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
      fetchImpl,
      ownerAuthorization: "owner-only-test-token",
      writeReportImpl: async (value, path) => { reportWrites.push({ value, path }); },
    });

    assert.equal(calls.length, 4);
    assert.equal(calls[1].input, "https://owner.csd.example/api/admin/migrations/v0.2.2/contract");
    assert.equal(calls[1].init.headers["oai-sites-authorization"], "Bearer owner-only-test-token");
    assert.equal(calls[2].input, "https://owner.csd.example/api/admin/migrations/v0.2.2");
    assert.equal(calls[2].init.method, "POST");
    assert.equal(calls[2].init.headers["x-csd-migration-filename"], "CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx");
    assert.equal(calls[2].init.headers["x-csd-migration-sha256"], SOURCE_SHA256);
    assert.deepEqual(Buffer.from(calls[2].init.body), sourceBytes);
    assert.equal(calls[3].input, "https://owner.csd.example/api/admin/migrations/v0.2.2/reconciliation");
    assert.equal(report.applyExecuted, true);
    assert.equal(report.targetStatus, "reconciled");
    assert.deepEqual(report.target, EXPECTED_TARGET);
    assert.equal(report.dashboard.asOfDate, "2026-07-23");
    assert.equal(reportWrites.length, 1);
    assert.match(reportWrites[0].path, /v022-applied\.json$/);
  });
});

test("--apply recovers a lost successful POST response from exact reconciliation after 409", async () => {
  await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
    const reportWrites = [];
    let callNumber = 0;
    const fetchImpl = async () => {
      callNumber += 1;
      if (callNumber === 1) return new Response(null, { status: 403 });
      if (callNumber === 2) return Response.json(deployedMigrationContract());
      if (callNumber === 3) return Response.json({ detail: "首版 v0.2.2 遷移已完成" }, { status: 409 });
      if (callNumber === 4) return Response.json(validReconciliation());
      throw new Error("unexpected request");
    };

    const report = await runMigration({
      args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
      fetchImpl,
      ownerAuthorization: "owner-only-test-token",
      writeReportImpl: async (value, path) => { reportWrites.push({ value, path }); },
    });

    assert.equal(callNumber, 4);
    assert.equal(report.targetStatus, "reconciled");
    assert.equal(report.migrationVersionId, 71);
    assert.equal(reportWrites.length, 1);
  });
});

test("--apply rejects reconciliation for a different source or migration without writing a report", async () => {
  for (const mismatch of [
    { sourceSha256: "0".repeat(64) },
    { migrationKey: "another-baseline" },
  ]) {
    await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
      const reportWrites = [];
      let callNumber = 0;
      const fetchImpl = async () => {
        callNumber += 1;
        if (callNumber === 1) return new Response(null, { status: 403 });
        if (callNumber === 2) return Response.json(deployedMigrationContract());
        if (callNumber === 3) return Response.json({
          version_id: 71,
          target: EXPECTED_TARGET,
          migration_version: "v0.2.2-baseline",
        }, { status: 201 });
        if (callNumber === 4) return Response.json(validReconciliation(mismatch));
        throw new Error("unexpected request");
      };

      await assert.rejects(runMigration({
        args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
        fetchImpl,
        ownerAuthorization: "owner-only-test-token",
        writeReportImpl: async (value, path) => { reportWrites.push({ value, path }); },
      }), /核對不符/);
      assert.equal(reportWrites.length, 0);
    });
  }
});

test("--apply rejects reconciliation with a missing or malformed version code without writing a report", async () => {
  for (const versionCode of [null, "version-71"]) {
    await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
      const reportWrites = [];
      let callNumber = 0;
      const fetchImpl = async () => {
        callNumber += 1;
        if (callNumber === 1) return new Response(null, { status: 403 });
        if (callNumber === 2) return Response.json(deployedMigrationContract());
        if (callNumber === 3) return Response.json({
          version_id: 71,
          target: EXPECTED_TARGET,
          migration_version: "v0.2.2-baseline",
        }, { status: 201 });
        if (callNumber === 4) return Response.json(validReconciliation({ versionCode }));
        throw new Error("unexpected request");
      };

      await assert.rejects(runMigration({
        args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
        fetchImpl,
        ownerAuthorization: "owner-only-test-token",
        writeReportImpl: async (value, path) => { reportWrites.push({ value, path }); },
      }), /核對不符/);
      assert.equal(reportWrites.length, 0);
    });
  }
});

test("--apply rejects bogus or incomplete dashboard reconciliation without writing a report", async () => {
  for (const dashboard of [
    { ...validReconciliation().dashboard, shortage_qty: 999 },
    { asOfDate: "2026-07-23", shortage_part_count: 5, shortage_qty: 137.1, in_transit_qty: 989 },
  ]) {
    await withPrivateDeploymentContract("https://owner.csd.example", async (contractPath) => {
      const reportWrites = [];
      let callNumber = 0;
      const fetchImpl = async () => {
        callNumber += 1;
        if (callNumber === 1) return new Response(null, { status: 403 });
        if (callNumber === 2) return Response.json(deployedMigrationContract());
        if (callNumber === 3) return Response.json({
          version_id: 71,
          target: EXPECTED_TARGET,
          migration_version: "v0.2.2-baseline",
        }, { status: 201 });
        if (callNumber === 4) return Response.json(validReconciliation({ dashboard }));
        throw new Error("unexpected request");
      };

      await assert.rejects(runMigration({
        args: ["--apply", "--endpoint", "https://owner.csd.example", "--private-deployment-contract", contractPath],
        fetchImpl,
        ownerAuthorization: "owner-only-test-token",
        writeReportImpl: async (value, path) => { reportWrites.push({ value, path }); },
      }), /核對不符/);
      assert.equal(reportWrites.length, 0);
    });
  }
});
