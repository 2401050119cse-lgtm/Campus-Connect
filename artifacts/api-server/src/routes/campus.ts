import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  BookmarkEventParams,
  BookmarkEventResponse,
  CancelEventRegistrationParams,
  CreateAnnouncementBody,
  CreateAnnouncementResponse,
  CreateEventBody,
  CreateEventResponse,
  DecideSubmissionBody,
  DecideSubmissionParams,
  DecideSubmissionResponse,
  DeleteAnnouncementParams,
  DeleteEventParams,
  GetAdminDashboardResponse,
  GetAnnouncementParams,
  GetAnnouncementResponse,
  GetCalendarQueryParams,
  GetCalendarResponse,
  GetDashboardResponse,
  GetEventParams,
  GetEventResponse,
  GetMeResponse,
  ListAnnouncementsQueryParams,
  ListAnnouncementsResponse,
  ListBookmarksResponse,
  ListEventsQueryParams,
  ListEventsResponse,
  ListMyRegistrationsResponse,
  ListNotificationsResponse,
  ListSubmissionsResponse,
  ListUsersQueryParams,
  ListUsersResponse,
  MarkNotificationReadParams,
  MarkNotificationReadResponse,
  RegisterForEventParams,
  RegisterForEventResponse,
  RemoveBookmarkParams,
  ReportContentBody,
  ReportContentResponse,
  SearchCampusQueryParams,
  SearchCampusResponse,
  UpdateAnnouncementBody,
  UpdateAnnouncementParams,
  UpdateAnnouncementResponse,
  UpdateEventBody,
  UpdateEventParams,
  UpdateEventResponse,
  UpdateMeBody,
  UpdateMeResponse,
  UpdateUserRoleBody,
  UpdateUserRoleParams,
  UpdateUserRoleResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  campusAnnouncementsTable as announcements,
  campusBookmarksTable as bookmarks,
  campusEventsTable as events,
  campusNotificationsTable as notifications,
  campusRegistrationsTable as registrations,
  campusReportsTable as reports,
  campusUsersTable as users,
} from "@workspace/db";
import { requireAdmin, requireAuth, requireCoordinator } from "../middlewares/campusAuth";

const router: IRouter = Router();
router.use(requireAuth);

type CampusUser = NonNullable<Express.Locals["campusUser"]>;
type EventRow = typeof events.$inferSelect;
type AnnouncementRow = typeof announcements.$inferSelect;

const currentUser = (res: Response): CampusUser => res.locals.campusUser!;

const registrationCount = sql<number>`(
  SELECT COUNT(*)::int
  FROM campus_registrations
  WHERE event_id = ${events.id} AND status = 'registered'
)`;

function eventRows(condition?: ReturnType<typeof and>) {
  return db
    .select({
      event: events,
      creatorName: users.name,
      registrationCount,
    })
    .from(events)
    .innerJoin(users, eq(events.createdBy, users.id))
    .where(condition)
    .orderBy(events.startsAt);
}

function eventDto(row: {
  event: EventRow;
  creatorName: string;
  registrationCount: number;
}) {
  return {
    ...row.event,
    registrationCount: Number(row.registrationCount),
    creatorName: row.creatorName,
    verified: row.event.approvalStatus === "approved",
  };
}

function announcementRows(condition?: ReturnType<typeof and>) {
  return db
    .select({ announcement: announcements, creatorName: users.name })
    .from(announcements)
    .innerJoin(users, eq(announcements.createdBy, users.id))
    .where(condition)
    .orderBy(desc(announcements.publishedAt), desc(announcements.createdAt));
}

function announcementDto(row: {
  announcement: AnnouncementRow;
  creatorName: string;
}) {
  return {
    ...row.announcement,
    creatorName: row.creatorName,
    verified: row.announcement.approvalStatus === "approved",
  };
}

function parsed<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
  value: unknown,
  res: Response,
): T | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    res.status(400).json({ error: result.error.message });
    return undefined;
  }
  return result.data;
}

function isValidTimeRange(startsAt: Date, endsAt: Date): boolean {
  return Number.isFinite(startsAt.getTime()) &&
    Number.isFinite(endsAt.getTime()) &&
    startsAt < endsAt;
}

function notifyUser(
  userId: string,
  title: string,
  message: string,
  type: "announcement" | "event" | "registration" | "deadline" | "system",
  resourceId?: string,
) {
  return db.insert(notifications).values({
    userId,
    title,
    message,
    type,
    resourceId: resourceId ?? null,
  });
}

async function notifyStudents(
  title: string,
  message: string,
  type: "announcement" | "event",
  resourceId: string,
  department: string | null,
) {
  const recipients = await db
    .select({ id: users.id })
    .from(users)
    .where(
      department
        ? and(eq(users.role, "student"), or(isNull(users.department), eq(users.department, department)))
        : eq(users.role, "student"),
    );
  if (recipients.length) {
    await db.insert(notifications).values(
      recipients.map(({ id }) => ({
        userId: id,
        title,
        message,
        type,
        resourceId,
      })),
    );
  }
}

async function findEvent(id: string, visibleTo: CampusUser) {
  const conditions = [
    eq(events.id, id),
    or(eq(events.approvalStatus, "approved"), eq(events.createdBy, visibleTo.id)),
  ];
  const [row] = await eventRows(and(...conditions)).limit(1);
  return row ? eventDto(row) : undefined;
}

async function findAnnouncement(id: string, visibleTo: CampusUser) {
  const [row] = await announcementRows(
    and(
      eq(announcements.id, id),
      or(
        eq(announcements.approvalStatus, "approved"),
        eq(announcements.createdBy, visibleTo.id),
      ),
    ),
  ).limit(1);
  return row ? announcementDto(row) : undefined;
}

router.get("/me", (_req, res): void => {
  res.json(GetMeResponse.parse(currentUser(res)));
});

router.patch("/me", async (req, res): Promise<void> => {
  const body = parsed(UpdateMeBody, req.body, res);
  if (!body) return;
  const user = currentUser(res);
  const [updated] = await db
    .update(users)
    .set(body)
    .where(eq(users.id, user.id))
    .returning();
  res.json(UpdateMeResponse.parse(updated));
});

router.get("/dashboard", async (_req, res): Promise<void> => {
  const user = currentUser(res);
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const nextThirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [todayUpdates, upcoming, deadlineRows, unread, registered, saved] =
    await Promise.all([
      announcementRows(
        and(
          eq(announcements.approvalStatus, "approved"),
          gte(announcements.publishedAt, todayStart),
          or(isNull(announcements.expiresAt), gte(announcements.expiresAt, now)),
          or(isNull(announcements.department), eq(announcements.department, user.department ?? "")),
        ),
      ),
      eventRows(
        and(
          eq(events.approvalStatus, "approved"),
          gte(events.startsAt, now),
          lte(events.startsAt, nextThirtyDays),
          or(isNull(events.department), eq(events.department, user.department ?? "")),
        ),
      ),
      db
        .select({ event: events, creatorName: users.name, registrationCount })
        .from(events)
        .innerJoin(users, eq(events.createdBy, users.id))
        .where(
          and(
            eq(events.approvalStatus, "approved"),
            gte(events.registrationDeadline, now),
            lte(events.registrationDeadline, nextThirtyDays),
          ),
        )
        .orderBy(events.registrationDeadline)
        .limit(5),
      db
        .select({ total: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))),
      db
        .select({ total: count() })
        .from(registrations)
        .where(and(eq(registrations.studentId, user.id), eq(registrations.status, "registered"))),
      db
        .select({ total: count() })
        .from(bookmarks)
        .where(eq(bookmarks.studentId, user.id)),
    ]);

  const importantDeadlines = deadlineRows.map((row) => ({
    id: row.event.id,
    title: `${row.event.title} registration closes`,
    kind: "deadline" as const,
    startsAt: row.event.registrationDeadline!,
    endsAt: null,
    venue: row.event.venue,
    category: row.event.category,
    registered: false,
    bookmarked: false,
  }));
  res.json(
    GetDashboardResponse.parse({
      todayAnnouncements: todayUpdates.map(announcementDto),
      upcomingEvents: upcoming.map(eventDto),
      importantDeadlines,
      unreadNotifications: Number(unread[0]?.total ?? 0),
      registeredEvents: Number(registered[0]?.total ?? 0),
      savedEvents: Number(saved[0]?.total ?? 0),
    }),
  );
});

router.get("/events", async (req, res): Promise<void> => {
  const query = parsed(ListEventsQueryParams, req.query, res);
  if (!query) return;
  const user = currentUser(res);
  const conditions = [];
  conditions.push(
    query.includeMine
      ? or(
          eq(events.approvalStatus, "approved"),
          and(eq(events.createdBy, user.id), ne(events.approvalStatus, "approved")),
        )
      : eq(events.approvalStatus, "approved"),
  );
  if (query.q?.trim()) {
    const term = `%${query.q.trim()}%`;
    conditions.push(or(ilike(events.title, term), ilike(events.description, term)));
  }
  if (query.category) conditions.push(eq(events.category, query.category));
  if (query.department) {
    conditions.push(
      or(
        isNull(events.department),
        eq(events.department, query.department),
      ),
    );
  }
  if (query.from) conditions.push(gte(events.startsAt, new Date(query.from)));
  if (query.to) conditions.push(lte(events.startsAt, new Date(`${query.to}T23:59:59.999Z`)));

  const rows = await eventRows(and(...conditions));
  res.json(ListEventsResponse.parse(rows.map(eventDto)));
});

router.post("/events", requireCoordinator, async (req, res): Promise<void> => {
  const body = parsed(CreateEventBody, req.body, res);
  if (!body) return;
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  const deadline = body.registrationDeadline ? new Date(body.registrationDeadline) : null;
  if (!isValidTimeRange(startsAt, endsAt) || (deadline && deadline >= startsAt)) {
    res.status(400).json({ error: "Event dates or registration deadline are invalid." });
    return;
  }
  const [created] = await db
    .insert(events)
    .values({
      ...body,
      startsAt,
      endsAt,
      registrationDeadline: deadline,
      approvalStatus: "pending",
      createdBy: currentUser(res).id,
    })
    .returning();
  const [owner] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, created.createdBy))
    .limit(1);
  res.status(201).json(
    CreateEventResponse.parse({ ...created, creatorName: owner.name, registrationCount: 0, verified: false }),
  );
});

router.get("/events/:id", async (req, res): Promise<void> => {
  const params = parsed(GetEventParams, req.params, res);
  if (!params) return;
  const event = await findEvent(params.id, currentUser(res));
  if (!event) {
    res.status(404).json({ error: "Event not found." });
    return;
  }
  res.json(GetEventResponse.parse(event));
});

router.patch("/events/:id", requireCoordinator, async (req, res): Promise<void> => {
  const params = parsed(UpdateEventParams, req.params, res);
  const body = parsed(UpdateEventBody, req.body, res);
  if (!params || !body) return;
  const user = currentUser(res);
  const [existing] = await db.select().from(events).where(eq(events.id, params.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Event not found." });
    return;
  }
  if (existing.createdBy !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "You can only update events you submitted." });
    return;
  }
  const startsAt = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
  const endsAt = body.endsAt ? new Date(body.endsAt) : existing.endsAt;
  const deadline =
    body.registrationDeadline === undefined
      ? existing.registrationDeadline
      : body.registrationDeadline
        ? new Date(body.registrationDeadline)
        : null;
  if (!isValidTimeRange(startsAt, endsAt) || (deadline && deadline >= startsAt)) {
    res.status(400).json({ error: "Event dates or registration deadline are invalid." });
    return;
  }
  const [updated] = await db
    .update(events)
    .set({
      ...body,
      startsAt,
      endsAt,
      registrationDeadline: deadline,
      approvalStatus: "pending",
      approvedBy: null,
      publishedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(events.id, params.id))
    .returning();
  const dto = await findEvent(updated.id, user);
  res.json(UpdateEventResponse.parse(dto));
});

router.delete("/events/:id", requireCoordinator, async (req, res): Promise<void> => {
  const params = parsed(DeleteEventParams, req.params, res);
  if (!params) return;
  const user = currentUser(res);
  const [existing] = await db.select().from(events).where(eq(events.id, params.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Event not found." });
    return;
  }
  if ((existing.createdBy !== user.id && user.role !== "admin") || existing.approvalStatus === "approved") {
    res.status(403).json({ error: "Only your unapproved submissions can be deleted." });
    return;
  }
  await db.delete(events).where(eq(events.id, params.id));
  res.sendStatus(204);
});

router.put("/events/:id/registration", async (req, res): Promise<void> => {
  const params = parsed(RegisterForEventParams, req.params, res);
  if (!params) return;
  const student = currentUser(res);
  const result = await db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, params.id), eq(events.approvalStatus, "approved")))
      .for("update")
      .limit(1);
    if (!event) return { kind: "not-found" as const };
    if (event.registrationDeadline && event.registrationDeadline < new Date()) {
      return { kind: "closed" as const };
    }
    const [existing] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.studentId, student.id)))
      .limit(1);
    if (existing && existing.status !== "cancelled") {
      return { kind: "ok" as const, row: existing };
    }
    const [countRow] = await tx
      .select({ total: count() })
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.status, "registered")));
    const isFull = event.maxParticipants !== null && Number(countRow.total) >= event.maxParticipants;
    const values = {
      eventId: event.id,
      studentId: student.id,
      registeredAt: new Date(),
      status: isFull ? "waitlisted" : "registered",
    };
    const [row] = existing
      ? await tx
          .update(registrations)
          .set(values)
          .where(eq(registrations.id, existing.id))
          .returning()
      : await tx.insert(registrations).values(values).returning();
    return { kind: "ok" as const, row };
  });
  if (result.kind === "not-found") {
    res.status(404).json({ error: "Verified event not found." });
    return;
  }
  if (result.kind === "closed") {
    res.status(409).json({ error: "Registration for this event has closed." });
    return;
  }
  res.json(RegisterForEventResponse.parse(result.row));
});

router.delete("/events/:id/registration", async (req, res): Promise<void> => {
  const params = parsed(CancelEventRegistrationParams, req.params, res);
  if (!params) return;
  const user = currentUser(res);
  await db
    .update(registrations)
    .set({ status: "cancelled" })
    .where(and(eq(registrations.eventId, params.id), eq(registrations.studentId, user.id)));
  res.sendStatus(204);
});

router.get("/registrations/me", async (_req, res): Promise<void> => {
  const user = currentUser(res);
  const rows = await db
    .select({ registration: registrations, event: events, creatorName: users.name, registrationCount })
    .from(registrations)
    .innerJoin(events, eq(registrations.eventId, events.id))
    .innerJoin(users, eq(events.createdBy, users.id))
    .where(and(eq(registrations.studentId, user.id), ne(registrations.status, "cancelled")))
    .orderBy(desc(registrations.registeredAt));
  res.json(
    ListMyRegistrationsResponse.parse(
      rows.map(({ registration, event, creatorName, registrationCount: total }) => ({
        registration,
        event: eventDto({ event, creatorName, registrationCount: total }),
      })),
    ),
  );
});

router.get("/bookmarks", async (_req, res): Promise<void> => {
  const user = currentUser(res);
  const rows = await db
    .select({ savedAt: bookmarks.createdAt, event: events, creatorName: users.name, registrationCount })
    .from(bookmarks)
    .innerJoin(events, eq(bookmarks.eventId, events.id))
    .innerJoin(users, eq(events.createdBy, users.id))
    .where(and(eq(bookmarks.studentId, user.id), eq(events.approvalStatus, "approved")))
    .orderBy(desc(bookmarks.createdAt));
  res.json(
    ListBookmarksResponse.parse(
      rows.map(({ event, creatorName, registrationCount: total, savedAt }) => ({
        event: eventDto({ event, creatorName, registrationCount: total }),
        savedAt,
      })),
    ),
  );
});

router.put("/bookmarks/:eventId", async (req, res): Promise<void> => {
  const params = parsed(BookmarkEventParams, req.params, res);
  if (!params) return;
  const user = currentUser(res);
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, params.eventId), eq(events.approvalStatus, "approved")))
    .limit(1);
  if (!event) {
    res.status(404).json({ error: "Verified event not found." });
    return;
  }
  await db
    .insert(bookmarks)
    .values({ studentId: user.id, eventId: event.id })
    .onConflictDoNothing();
  const [row] = await db
    .select({ savedAt: bookmarks.createdAt })
    .from(bookmarks)
    .where(and(eq(bookmarks.studentId, user.id), eq(bookmarks.eventId, event.id)))
    .limit(1);
  const dto = await findEvent(event.id, user);
  res.json(BookmarkEventResponse.parse({ event: dto, savedAt: row.savedAt }));
});

router.delete("/bookmarks/:eventId", async (req, res): Promise<void> => {
  const params = parsed(RemoveBookmarkParams, req.params, res);
  if (!params) return;
  const user = currentUser(res);
  await db
    .delete(bookmarks)
    .where(and(eq(bookmarks.studentId, user.id), eq(bookmarks.eventId, params.eventId)));
  res.sendStatus(204);
});

router.get("/announcements", async (req, res): Promise<void> => {
  const query = parsed(ListAnnouncementsQueryParams, req.query, res);
  if (!query) return;
  const user = currentUser(res);
  const conditions = [
    or(
      eq(announcements.approvalStatus, "approved"),
      eq(announcements.createdBy, user.id),
    ),
  ];
  if (query.q?.trim()) {
    const term = `%${query.q.trim()}%`;
    conditions.push(or(ilike(announcements.title, term), ilike(announcements.content, term)));
  }
  if (query.category) conditions.push(eq(announcements.category, query.category));
  if (query.department) {
    conditions.push(
      or(isNull(announcements.department), eq(announcements.department, query.department)),
    );
  }
  if (query.priority) conditions.push(eq(announcements.priority, query.priority));
  conditions.push(or(isNull(announcements.expiresAt), gte(announcements.expiresAt, new Date())));
  const rows = await announcementRows(and(...conditions));
  res.json(ListAnnouncementsResponse.parse(rows.map(announcementDto)));
});

router.post("/announcements", requireCoordinator, async (req, res): Promise<void> => {
  const body = parsed(CreateAnnouncementBody, req.body, res);
  if (!body) return;
  const [created] = await db
    .insert(announcements)
    .values({
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      createdBy: currentUser(res).id,
      approvalStatus: "pending",
    })
    .returning();
  const [owner] = await db.select({ name: users.name }).from(users).where(eq(users.id, created.createdBy));
  res.status(201).json(
    CreateAnnouncementResponse.parse({
      ...created,
      creatorName: owner.name,
      verified: false,
    }),
  );
});

router.get("/announcements/:id", async (req, res): Promise<void> => {
  const params = parsed(GetAnnouncementParams, req.params, res);
  if (!params) return;
  const announcement = await findAnnouncement(params.id, currentUser(res));
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  res.json(GetAnnouncementResponse.parse(announcement));
});

router.patch("/announcements/:id", requireCoordinator, async (req, res): Promise<void> => {
  const params = parsed(UpdateAnnouncementParams, req.params, res);
  const body = parsed(UpdateAnnouncementBody, req.body, res);
  if (!params || !body) return;
  const user = currentUser(res);
  const [existing] = await db
    .select()
    .from(announcements)
    .where(eq(announcements.id, params.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  if (existing.createdBy !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "You can only update announcements you submitted." });
    return;
  }
  const [updated] = await db
    .update(announcements)
    .set({
      ...body,
      expiresAt:
        body.expiresAt === undefined
          ? existing.expiresAt
          : body.expiresAt
            ? new Date(body.expiresAt)
            : null,
      approvalStatus: "pending",
      approvedBy: null,
      publishedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(announcements.id, params.id))
    .returning();
  const dto = await findAnnouncement(updated.id, user);
  res.json(UpdateAnnouncementResponse.parse(dto));
});

router.delete("/announcements/:id", requireCoordinator, async (req, res): Promise<void> => {
  const params = parsed(DeleteAnnouncementParams, req.params, res);
  if (!params) return;
  const user = currentUser(res);
  const [existing] = await db
    .select()
    .from(announcements)
    .where(eq(announcements.id, params.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  if ((existing.createdBy !== user.id && user.role !== "admin") || existing.approvalStatus === "approved") {
    res.status(403).json({ error: "Only your unapproved submissions can be deleted." });
    return;
  }
  await db.delete(announcements).where(eq(announcements.id, params.id));
  res.sendStatus(204);
});

router.get("/notifications", async (_req, res): Promise<void> => {
  const user = currentUser(res);
  const items = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, user.id))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
  res.json(ListNotificationsResponse.parse(items));
});

router.patch("/notifications/:id/read", async (req, res): Promise<void> => {
  const params = parsed(MarkNotificationReadParams, req.params, res);
  if (!params) return;
  const [updated] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, params.id),
        eq(notifications.userId, currentUser(res).id),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Notification not found." });
    return;
  }
  res.json(MarkNotificationReadResponse.parse(updated));
});

router.get("/calendar", async (req, res): Promise<void> => {
  const query = parsed(GetCalendarQueryParams, req.query, res);
  if (!query) return;
  const user = currentUser(res);
  const from = new Date(`${query.from}T00:00:00.000Z`);
  const to = new Date(`${query.to}T23:59:59.999Z`);
  if (from > to) {
    res.status(400).json({ error: "The calendar end date must follow the start date." });
    return;
  }
  const rows = await eventRows(
    and(
      eq(events.approvalStatus, "approved"),
      lte(events.startsAt, to),
      gte(events.endsAt, from),
      or(isNull(events.department), eq(events.department, user.department ?? "")),
    ),
  );
  const eventIds = rows.map(({ event }) => event.id);
  const [myRegistrations, myBookmarks] = eventIds.length
    ? await Promise.all([
        db
          .select({ eventId: registrations.eventId })
          .from(registrations)
          .where(
            and(
              eq(registrations.studentId, user.id),
              eq(registrations.status, "registered"),
              inArray(registrations.eventId, eventIds),
            ),
          ),
        db
          .select({ eventId: bookmarks.eventId })
          .from(bookmarks)
          .where(and(eq(bookmarks.studentId, user.id), inArray(bookmarks.eventId, eventIds))),
      ])
    : [[], []];
  const registeredIds = new Set(myRegistrations.map((row) => row.eventId));
  const bookmarkedIds = new Set(myBookmarks.map((row) => row.eventId));
  res.json(
    GetCalendarResponse.parse(
      rows.map(({ event }) => ({
        id: event.id,
        title: event.title,
        kind:
          event.category === "Exams"
            ? "exam"
            : event.category === "Deadlines"
              ? "deadline"
              : "event",
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        venue: event.venue,
        category: event.category,
        registered: registeredIds.has(event.id),
        bookmarked: bookmarkedIds.has(event.id),
      })),
    ),
  );
});

router.get("/search", async (req, res): Promise<void> => {
  const query = parsed(SearchCampusQueryParams, req.query, res);
  if (!query) return;
  const user = currentUser(res);
  const term = `%${query.q.trim()}%`;
  const [eventResults, announcementResults] = await Promise.all([
    eventRows(
      and(
        eq(events.approvalStatus, "approved"),
        or(ilike(events.title, term), ilike(events.description, term)),
        or(isNull(events.department), eq(events.department, user.department ?? "")),
      ),
    ),
    announcementRows(
      and(
        eq(announcements.approvalStatus, "approved"),
        or(ilike(announcements.title, term), ilike(announcements.content, term)),
        or(isNull(announcements.department), eq(announcements.department, user.department ?? "")),
      ),
    ),
  ]);
  const results = [
    ...eventResults.map(({ event }) => ({
      id: event.id,
      kind: "event" as const,
      title: event.title,
      excerpt: event.description.slice(0, 180),
      category: event.category,
      department: event.department,
      date: event.startsAt,
      verified: true,
    })),
    ...announcementResults.map(({ announcement }) => ({
      id: announcement.id,
      kind: "announcement" as const,
      title: announcement.title,
      excerpt: announcement.content.slice(0, 180),
      category: announcement.category,
      department: announcement.department,
      date: announcement.publishedAt,
      verified: true,
    })),
  ].sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  res.json(SearchCampusResponse.parse(results));
});

router.post("/reports", async (req, res): Promise<void> => {
  const body = parsed(ReportContentBody, req.body, res);
  if (!body) return;
  const exists =
    body.resourceType === "event"
      ? await db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, body.resourceId), eq(events.approvalStatus, "approved")))
          .limit(1)
      : await db
          .select({ id: announcements.id })
          .from(announcements)
          .where(and(eq(announcements.id, body.resourceId), eq(announcements.approvalStatus, "approved")))
          .limit(1);
  if (!exists.length) {
    res.status(404).json({ error: "Verified information not found." });
    return;
  }
  const [created] = await db
    .insert(reports)
    .values({ ...body, userId: currentUser(res).id })
    .returning();
  res.status(201).json(ReportContentResponse.parse(created));
});

router.get("/admin/dashboard", requireAdmin, async (_req, res): Promise<void> => {
  const now = new Date();
  const [studentTotal, eventTotal, pendingEventTotal, pendingAnnouncementTotal, upcomingTotal, activeAnnouncementTotal, pendingReportTotal] =
    await Promise.all([
      db.select({ total: count() }).from(users).where(eq(users.role, "student")),
      db.select({ total: count() }).from(events).where(eq(events.approvalStatus, "approved")),
      db.select({ total: count() }).from(events).where(eq(events.approvalStatus, "pending")),
      db.select({ total: count() }).from(announcements).where(eq(announcements.approvalStatus, "pending")),
      db
        .select({ total: count() })
        .from(events)
        .where(and(eq(events.approvalStatus, "approved"), gte(events.startsAt, now))),
      db
        .select({ total: count() })
        .from(announcements)
        .where(
          and(
            eq(announcements.approvalStatus, "approved"),
            or(isNull(announcements.expiresAt), gte(announcements.expiresAt, now)),
          ),
        ),
      db.select({ total: count() }).from(reports).where(eq(reports.status, "open")),
    ]);
  res.json(
    GetAdminDashboardResponse.parse({
      totalStudents: Number(studentTotal[0]?.total ?? 0),
      totalEvents: Number(eventTotal[0]?.total ?? 0),
      pendingApprovals: Number(pendingEventTotal[0]?.total ?? 0) + Number(pendingAnnouncementTotal[0]?.total ?? 0),
      upcomingEvents: Number(upcomingTotal[0]?.total ?? 0),
      activeAnnouncements: Number(activeAnnouncementTotal[0]?.total ?? 0),
      pendingReports: Number(pendingReportTotal[0]?.total ?? 0),
    }),
  );
});

router.get("/admin/submissions", requireAdmin, async (_req, res): Promise<void> => {
  const [eventSubmissions, announcementSubmissions] = await Promise.all([
    db
      .select({ event: events, submitterName: users.name })
      .from(events)
      .innerJoin(users, eq(events.createdBy, users.id))
      .where(eq(events.approvalStatus, "pending")),
    db
      .select({ announcement: announcements, submitterName: users.name })
      .from(announcements)
      .innerJoin(users, eq(announcements.createdBy, users.id))
      .where(eq(announcements.approvalStatus, "pending")),
  ]);
  const submissions = [
    ...eventSubmissions.map(({ event, submitterName }) => ({
      id: event.id,
      kind: "event" as const,
      title: event.title,
      summary: event.description.slice(0, 240),
      category: event.category,
      department: event.department,
      submittedBy: event.createdBy,
      submitterName,
      createdAt: event.createdAt,
    })),
    ...announcementSubmissions.map(({ announcement, submitterName }) => ({
      id: announcement.id,
      kind: "announcement" as const,
      title: announcement.title,
      summary: announcement.content.slice(0, 240),
      category: announcement.category,
      department: announcement.department,
      submittedBy: announcement.createdBy,
      submitterName,
      createdAt: announcement.createdAt,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  res.json(ListSubmissionsResponse.parse(submissions));
});

router.post("/admin/submissions/:id/decision", requireAdmin, async (req, res): Promise<void> => {
  const params = parsed(DecideSubmissionParams, req.params, res);
  const body = parsed(DecideSubmissionBody, req.body, res);
  if (!params || !body) return;
  const admin = currentUser(res);
  const approved = body.decision === "approve";
  let content:
    | { id: string; title: string; createdBy: string; department: string | null }
    | undefined;
  let submission: unknown;
  if (body.kind === "event") {
    const [row] = await db
      .update(events)
      .set({
        approvalStatus: approved ? "approved" : "rejected",
        approvedBy: admin.id,
        publishedAt: approved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(events.id, params.id), eq(events.approvalStatus, "pending")))
      .returning();
    if (row) {
      content = { id: row.id, title: row.title, createdBy: row.createdBy, department: row.department };
      const [submitter] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, row.createdBy))
        .limit(1);
      submission = {
        id: row.id,
        kind: "event",
        title: row.title,
        summary: row.description.slice(0, 240),
        category: row.category,
        department: row.department,
        submittedBy: row.createdBy,
        submitterName: submitter.name,
        createdAt: row.createdAt,
      };
      if (approved) await notifyStudents("New verified campus event", `${row.title} is now published.`, "event", row.id, row.department);
      else await notifyUser(row.createdBy, "Submission needs an update", `${row.title} was not approved. ${body.note ?? ""}`.trim(), "system", row.id);
    }
  } else {
    const [row] = await db
      .update(announcements)
      .set({
        approvalStatus: approved ? "approved" : "rejected",
        approvedBy: admin.id,
        publishedAt: approved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(announcements.id, params.id), eq(announcements.approvalStatus, "pending")))
      .returning();
    if (row) {
      content = { id: row.id, title: row.title, createdBy: row.createdBy, department: row.department };
      const [submitter] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, row.createdBy))
        .limit(1);
      submission = {
        id: row.id,
        kind: "announcement",
        title: row.title,
        summary: row.content.slice(0, 240),
        category: row.category,
        department: row.department,
        submittedBy: row.createdBy,
        submitterName: submitter.name,
        createdAt: row.createdAt,
      };
      if (approved) await notifyStudents("New verified campus announcement", row.title, "announcement", row.id, row.department);
      else await notifyUser(row.createdBy, "Submission needs an update", `${row.title} was not approved. ${body.note ?? ""}`.trim(), "system", row.id);
    }
  }
  if (!content || !submission) {
    res.status(404).json({ error: "Pending submission not found." });
    return;
  }
  res.json(DecideSubmissionResponse.parse(submission));
});

router.get("/admin/users", requireAdmin, async (req, res): Promise<void> => {
  const query = parsed(ListUsersQueryParams, req.query, res);
  if (!query) return;
  const usersList = await db
    .select()
    .from(users)
    .where(query.q?.trim() ? or(ilike(users.name, `%${query.q.trim()}%`), ilike(users.email, `%${query.q.trim()}%`)) : undefined)
    .orderBy(users.name)
    .limit(100);
  res.json(ListUsersResponse.parse(usersList));
});

router.patch("/admin/users/:id/role", requireAdmin, async (req, res): Promise<void> => {
  const params = parsed(UpdateUserRoleParams, req.params, res);
  const body = parsed(UpdateUserRoleBody, req.body, res);
  if (!params || !body) return;
  const [target] = await db.select().from(users).where(eq(users.id, params.id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "Campus account not found." });
    return;
  }
  if (target.role === "admin") {
    res.status(403).json({ error: "Administrator roles are managed through the server allowlist." });
    return;
  }
  const [updated] = await db
    .update(users)
    .set({ role: body.role })
    .where(eq(users.id, params.id))
    .returning();
  res.json(UpdateUserRoleResponse.parse(updated));
});

export default router;