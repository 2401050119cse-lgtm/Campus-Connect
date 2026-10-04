import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const campusUsersTable = pgTable(
  "campus_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authId: text("auth_id").notNull().unique(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("student"),
    department: text("department"),
    year: integer("year"),
    interests: text("interests")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("campus_users_email_idx").on(table.email)],
);

export const campusEventsTable = pgTable(
  "campus_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    department: text("department"),
    organizer: text("organizer").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    venue: text("venue").notNull(),
    eligibility: text("eligibility"),
    registrationUrl: text("registration_url"),
    registrationDeadline: timestamp("registration_deadline", {
      withTimezone: true,
    }),
    maxParticipants: integer("max_participants"),
    approvalStatus: text("approval_status").notNull().default("pending"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => campusUsersTable.id),
    approvedBy: uuid("approved_by").references(() => campusUsersTable.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("campus_events_status_date_idx").on(
      table.approvalStatus,
      table.startsAt,
    ),
    index("campus_events_category_idx").on(table.category),
    index("campus_events_department_idx").on(table.department),
  ],
);

export const campusAnnouncementsTable = pgTable(
  "campus_announcements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull(),
    department: text("department"),
    priority: text("priority").notNull().default("normal"),
    attachmentUrl: text("attachment_url"),
    approvalStatus: text("approval_status").notNull().default("pending"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => campusUsersTable.id),
    approvedBy: uuid("approved_by").references(() => campusUsersTable.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("campus_announcements_status_date_idx").on(
      table.approvalStatus,
      table.publishedAt,
    ),
    index("campus_announcements_category_idx").on(table.category),
  ],
);

export const campusRegistrationsTable = pgTable(
  "campus_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => campusEventsTable.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: text("status").notNull().default("registered"),
  },
  (table) => [
    uniqueIndex("campus_registrations_event_student_idx").on(
      table.eventId,
      table.studentId,
    ),
    index("campus_registrations_student_idx").on(table.studentId),
  ],
);

export const campusBookmarksTable = pgTable(
  "campus_bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => campusEventsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("campus_bookmarks_student_event_idx").on(
      table.studentId,
      table.eventId,
    ),
  ],
);

export const campusNotificationsTable = pgTable(
  "campus_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    message: text("message").notNull(),
    type: text("type").notNull(),
    resourceId: uuid("resource_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("campus_notifications_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const campusReportsTable = pgTable(
  "campus_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => campusUsersTable.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    reason: text("reason").notNull(),
    details: text("details"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("campus_reports_status_idx").on(table.status)],
);