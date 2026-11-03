CREATE TABLE "access_requests" (
	"email" text PRIMARY KEY,
	"code" text DEFAULT '' NOT NULL,
	"pass_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "access_requests_status_idx" ON "access_requests" ("status","created_at");