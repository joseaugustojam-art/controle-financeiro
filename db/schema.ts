import { pgTable, text, timestamp, integer, jsonb, index, boolean } from "drizzle-orm/pg-core";

// Licença por e-mail (criada pela Hotmart ou manualmente pelo admin)
export const licenses = pgTable("licenses", {
  email: text().primaryKey(),
  code: text().notNull(),
  status: text().notNull().default("active"), // active | revoked
  source: text().notNull().default("hotmart"), // hotmart | admin
  lastEvent: text("last_event"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  passHash: text("pass_hash").notNull(),
  tokenVersion: integer("token_version").notNull().default(1),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const userData = pgTable("user_data", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  docs: jsonb().notNull().default({}),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const ocrJobs = pgTable(
  "ocr_jobs",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text().notNull().default("pending"), // pending | running | done | error
    meta: jsonb(),
    result: jsonb(),
    message: text(),
    code: text(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("ocr_jobs_user_created_idx").on(t.userId, t.createdAt)],
);

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});

// Pedido de acesso feito no "Primeiro acesso" quando não há compra confirmada para o e-mail/código.
// O administrador aprova ou recusa no painel /admin.
export const accessRequests = pgTable(
  "access_requests",
  {
    email: text().primaryKey(),
    code: text().notNull().default(""),
    passHash: text("pass_hash").notNull(),
    status: text().notNull().default("pending"), // pending | approved | rejected
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("access_requests_status_idx").on(t.status, t.createdAt)],
);

// Código master para testes: qualquer e-mail pode fazer o "Primeiro acesso" com ele, até o limite de usos.
export const masterCodes = pgTable("master_codes", {
  code: text().primaryKey(),
  maxUses: integer("max_uses").notNull().default(10),
  uses: integer().notNull().default(0),
  active: boolean().notNull().default(true),
  note: text().notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
