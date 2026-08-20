import Link from "next/link";
import { redirect } from "next/navigation";

import { requirePageUser } from "@/lib/auth";
import { listProjects, listUsers } from "@/lib/repositories";
import {
  getOrganizationAuditEventTypes,
  getOrganizationAuditLog,
} from "@/lib/services";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function queryInput(searchParams: SearchParams): Record<string, string> {
  return Object.fromEntries(
    Object.entries(searchParams)
      .map(([key, value]) => [key, firstValue(value)])
      .filter(([, value]) => value !== ""),
  );
}

function pageHref(filters: Record<string, string>, page: number): string {
  const params = new URLSearchParams(filters);
  params.set("page", String(page));
  return `/audit?${params.toString()}`;
}

function displayDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

const categoryLabels: Record<string, string> = {
  agent_connection: "Agent credential",
  agent_permission: "Agent permission",
  agent_session: "Agent session",
  auth: "Account security",
  change_request: "Change request",
  integration: "Integration",
  integration_agent: "Integration Agent",
  membership: "Membership",
  project: "Project",
  task: "Task",
  task_preview: "Preview",
};

function eventCategory(eventType: string): string {
  return categoryLabels[eventType.split(".")[0] ?? ""] ?? "System";
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requirePageUser();
  if (actor.role !== "admin") {
    redirect("/");
  }

  const filters = queryInput(await searchParams);
  const [result, eventTypes, users, projects] = await Promise.all([
    getOrganizationAuditLog(filters, actor.id),
    getOrganizationAuditEventTypes(actor.id),
    listUsers(actor.organizationId),
    listProjects(actor.id),
  ]);

  return (
    <>
      <section className="section-head">
        <div>
          <span className="eyebrow">Organization governance</span>
          <h1>Audit log</h1>
          <p>Search critical actions by actor, project, event, and time, then inspect the original evidence stored by the platform.</p>
        </div>
      </section>

      <section className="panel audit-filter-panel">
        <form className="form" method="get">
          <div className="audit-filter-grid">
            <label>
              Event type
              <select name="eventType" defaultValue={filters.eventType ?? ""}>
                <option value="">All events</option>
                {eventTypes.map((eventType) => (
                  <option key={eventType} value={eventType}>{eventType}</option>
                ))}
              </select>
            </label>
            <label>
              Actor
              <select name="actorId" defaultValue={filters.actorId ?? ""}>
                <option value="">All members</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>{user.name} · {user.email}</option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select name="projectId" defaultValue={filters.projectId ?? ""}>
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label>
              Task ID
              <input name="taskId" defaultValue={filters.taskId ?? ""} placeholder="UUID" />
            </label>
            <label>
              Start date
              <input name="from" type="date" defaultValue={filters.from ?? ""} />
            </label>
            <label>
              End date
              <input name="to" type="date" defaultValue={filters.to ?? ""} />
            </label>
            <label className="audit-search-field">
              Search evidence
              <input
                name="search"
                defaultValue={filters.search ?? ""}
                placeholder="Event, member, project, task, or payload"
              />
            </label>
            <label>
              Per page
              <select name="pageSize" defaultValue={String(result.pageSize)}>
                <option value="25">25 rows</option>
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
              </select>
            </label>
          </div>
          <div className="button-row">
            <button className="button" type="submit">Search</button>
            <Link className="button secondary" href="/audit">Reset</Link>
          </div>
        </form>
      </section>

      <section className="section-head audit-result-head">
        <div>
          <h2>Results</h2>
          <p>{result.total} events, page {result.page} of {result.pageCount}.</p>
        </div>
      </section>

      {result.events.length === 0 ? (
        <div className="empty">No audit events match the current filters.</div>
      ) : (
        <section className="panel table-scroll audit-table-panel">
          <table className="data-table audit-table">
            <thead>
              <tr><th>Time and event</th><th>Actor</th><th>Scope</th><th>Original evidence</th></tr>
            </thead>
            <tbody>
              {result.events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <span className="status status-neutral">{eventCategory(event.eventType)}</span>
                    <strong className="audit-event-type">{event.eventType}</strong>
                    <small>{displayDate(event.createdAt)}</small>
                    <small><code>{event.id}</code></small>
                  </td>
                  <td>
                    <strong>{event.actorName ?? "System"}</strong>
                    <small>{event.actorEmail ?? "No actor account"}</small>
                    {event.actorId && <small><code>{event.actorId}</code></small>}
                  </td>
                  <td>
                    {event.projectId ? (
                      <Link href={`/projects/${event.projectId}`}><strong>{event.projectName ?? "Deleted project"}</strong></Link>
                    ) : (
                      <span className="muted">Organization event</span>
                    )}
                    {event.taskId && (
                      <small><Link href={`/tasks/${event.taskId}`}>{event.taskTitle ?? event.taskId}</Link></small>
                    )}
                  </td>
                  <td>
                    <details className="audit-payload">
                      <summary>View JSON</summary>
                      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <nav className="audit-pagination" aria-label="Audit pagination">
        {result.page > 1 ? (
          <Link className="button secondary" href={pageHref(filters, result.page - 1)}>Previous</Link>
        ) : <span />}
        {result.page < result.pageCount && (
          <Link className="button secondary" href={pageHref(filters, result.page + 1)}>Next</Link>
        )}
      </nav>
    </>
  );
}
