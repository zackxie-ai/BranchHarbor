import { randomUUID } from "node:crypto";

import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import { insertProject, recordAudit } from "../apps/control-plane/src/lib/repositories";
import { getOrganizationAuditLog } from "../apps/control-plane/src/lib/services";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = randomUUID();
const otherOrganizationId = randomUUID();
const otherUserId = randomUUID();
const projectId = randomUUID();
const marker = `audit-smoke-${randomUUID()}`;

async function expectAdminRequired(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === "ADMIN_REQUIRED") {
      return;
    }
    throw error;
  }
  throw new Error("Expected member audit query to require Admin permission");
}

async function main() {
  try {
    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      memberId,
      `${marker}@branchharbor.local`,
      "Audit Smoke Member",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'member')",
      [config.organizationId, memberId],
    );
    await insertProject({
      id: projectId,
      name: "Audit Query Smoke",
      slug: `audit-query-${projectId.slice(0, 8)}`,
      giteaOwner: "smoke",
      giteaRepository: `audit-query-${projectId.slice(0, 8)}`,
      repositoryUrl: `/tmp/${projectId}.git`,
      localRepositoryPath: `/tmp/${projectId}`,
      actorId: adminId,
    });

    for (let index = 0; index < 27; index += 1) {
      await recordAudit({
        actorId: index === 0 ? memberId : adminId,
        projectId: index < 15 ? projectId : undefined,
        eventType: index % 2 === 0 ? "audit_smoke.created" : "audit_smoke.updated",
        payload: { marker, index },
      });
    }
    await query(
      `UPDATE audit_events
          SET created_at = NOW() - INTERVAL '2 days'
        WHERE payload->>'marker' = $1 AND payload->>'index' = '26'`,
      [marker],
    );

    await query("INSERT INTO organizations (id, slug, name) VALUES ($1,$2,$3)", [
      otherOrganizationId,
      `audit-smoke-${otherOrganizationId.slice(0, 8)}`,
      "Other Audit Organization",
    ]);
    await query("INSERT INTO users (id, email, name) VALUES ($1,$2,$3)", [
      otherUserId,
      `other-${marker}@branchharbor.local`,
      "Other Audit User",
    ]);
    await query(
      "INSERT INTO memberships (organization_id, user_id, role) VALUES ($1,$2,'admin')",
      [otherOrganizationId, otherUserId],
    );
    await query(
      `INSERT INTO audit_events (id, organization_id, actor_id, event_type, payload)
       VALUES ($1,$2,$3,'audit_smoke.created',$4::JSONB)`,
      [randomUUID(), otherOrganizationId, otherUserId, JSON.stringify({ marker, foreign: true })],
    );

    await expectAdminRequired(() => getOrganizationAuditLog({ search: marker }, memberId));

    const firstPage = await getOrganizationAuditLog({ search: marker }, adminId);
    const secondPage = await getOrganizationAuditLog({ search: marker, page: 2 }, adminId);
    if (firstPage.total !== 27 || firstPage.events.length !== 25 || secondPage.events.length !== 2) {
      throw new Error("Audit pagination or organization isolation is incorrect");
    }
    if (firstPage.events.some((event) => event.organizationId !== config.organizationId)) {
      throw new Error("Cross-organization audit event leaked into the result");
    }

    const created = await getOrganizationAuditLog(
      { search: marker, eventType: "audit_smoke.created" },
      adminId,
    );
    if (created.total !== 14) {
      throw new Error(`Expected 14 exact event type matches, received ${created.total}`);
    }

    const memberEvents = await getOrganizationAuditLog(
      { search: marker, actorId: memberId },
      adminId,
    );
    if (memberEvents.total !== 1 || memberEvents.events[0]?.actorName !== "Audit Smoke Member") {
      throw new Error("Actor filtering or joined actor context is incorrect");
    }

    const shanghaiDateParts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const datePart = (type: Intl.DateTimeFormatPartTypes) =>
      shanghaiDateParts.find((part) => part.type === type)?.value ?? "";
    const shanghaiDate = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
    const dated = await getOrganizationAuditLog(
      { search: marker, from: shanghaiDate, to: shanghaiDate, pageSize: 50 },
      adminId,
    );
    if (dated.total !== 26) {
      throw new Error("Shanghai date boundary filtering is incorrect");
    }

    const projectEvents = await getOrganizationAuditLog(
      { search: marker, projectId, pageSize: 50 },
      adminId,
    );
    if (projectEvents.total !== 15 || projectEvents.events.some((event) => !event.projectName)) {
      throw new Error("Project audit filtering or joined display context is incorrect");
    }

    await query("DELETE FROM projects WHERE id = $1", [projectId]);
    const retained = await getOrganizationAuditLog({ search: marker, pageSize: 50 }, adminId);
    if (retained.total !== 27 || retained.events.some((event) => event.projectId !== null)) {
      throw new Error("Audit history was not retained after project deletion");
    }

    console.log(
      JSON.stringify({
        adminOnly: true,
        organizationIsolated: true,
        exactFilters: true,
        actorFilter: true,
        shanghaiDateFilter: true,
        payloadSearch: true,
        stablePagination: true,
        deletedProjectHistoryRetained: true,
        total: retained.total,
      }),
    );
  } finally {
    await query("DELETE FROM audit_events WHERE payload->>'marker' = $1", [marker]).catch(
      () => undefined,
    );
    await query("DELETE FROM projects WHERE id = $1", [projectId]).catch(() => undefined);
    await query("DELETE FROM users WHERE id = $1", [memberId]).catch(() => undefined);
    await query("DELETE FROM organizations WHERE id = $1", [otherOrganizationId]).catch(
      () => undefined,
    );
    await query("DELETE FROM users WHERE id = $1", [otherUserId]).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
