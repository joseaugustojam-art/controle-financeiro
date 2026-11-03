CREATE TABLE "licenses" (
	"email" text PRIMARY KEY,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'hotmart' NOT NULL,
	"last_event" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocr_jobs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta" jsonb,
	"result" jsonb,
	"message" text,
	"code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_data" (
	"user_id" text PRIMARY KEY,
	"docs" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL UNIQUE,
	"pass_hash" text NOT NULL,
	"token_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ocr_jobs_user_created_idx" ON "ocr_jobs" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_data" ADD CONSTRAINT "user_data_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;