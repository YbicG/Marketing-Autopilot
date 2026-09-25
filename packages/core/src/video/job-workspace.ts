import { eq } from "drizzle-orm";
import { schema, type Db } from "@mkt/db";

const { contentItems, renders } = schema;

/**
 * Video deps are per workspace (the ElevenLabs key is vault-first, D19), but render jobs carry only
 * row ids. These resolve the owning workspace; null = the row is gone, so the job has nothing to do.
 */
export async function workspaceOfRender(db: Db, renderId: string): Promise<string | null> {
  const [r] = await db.select({ ws: renders.workspaceId }).from(renders).where(eq(renders.id, renderId));
  return r?.ws ?? null;
}

export async function workspaceOfContentItem(db: Db, contentItemId: string): Promise<string | null> {
  const [r] = await db.select({ ws: contentItems.workspaceId }).from(contentItems).where(eq(contentItems.id, contentItemId));
  return r?.ws ?? null;
}
