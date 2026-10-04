import { getAuth, clerkClient } from "@clerk/express";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db, campusUsersTable } from "@workspace/db";

type CampusUser = typeof campusUsersTable.$inferSelect;

declare global {
  namespace Express {
    interface Locals {
      campusUser?: CampusUser;
    }
  }
}

const adminEmails = new Set(
  (process.env.CAMPUS_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = getAuth(req);
    const authId = auth.userId;
    if (!authId) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }

    const [existing] = await db
      .select()
      .from(campusUsersTable)
      .where(eq(campusUsersTable.authId, authId))
      .limit(1);

    if (existing) {
      if (
        existing.role !== "admin" &&
        adminEmails.has(existing.email.toLowerCase())
      ) {
        const [promoted] = await db
          .update(campusUsersTable)
          .set({ role: "admin" })
          .where(eq(campusUsersTable.id, existing.id))
          .returning();
        res.locals.campusUser = promoted;
      } else {
        res.locals.campusUser = existing;
      }
      next();
      return;
    }

    const clerkUser = await clerkClient.users.getUser(authId);
    const email =
      clerkUser.primaryEmailAddress?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress;
    if (!email) {
      res.status(403).json({
        error: "Add a verified email address to your account before continuing.",
      });
      return;
    }

    const name =
      clerkUser.fullName?.trim() ||
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
      email.split("@")[0] ||
      "Campus member";
    const role = adminEmails.has(email.toLowerCase()) ? "admin" : "student";
    const [created] = await db
      .insert(campusUsersTable)
      .values({ authId, name, email, role })
      .onConflictDoUpdate({
        target: campusUsersTable.authId,
        set: { name, email },
      })
      .returning();
    res.locals.campusUser = created;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCoordinator(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = res.locals.campusUser?.role;
  if (role !== "coordinator" && role !== "admin") {
    res.status(403).json({ error: "Coordinator access is required." });
    return;
  }
  next();
}

export function requireAdmin(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.locals.campusUser?.role !== "admin") {
    res.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
}