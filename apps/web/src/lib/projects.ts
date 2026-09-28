import { cache } from "react";
import { projectSummaries, reconnectCount } from "@mkt/core/publishing";
import { getDb } from "./db";

/** Per-render caches so the sidebar and the page share one read of the project list. */
export const loadProjects = cache((workspaceId: string) => projectSummaries(getDb(), workspaceId));
export const loadReconnects = cache((workspaceId: string) => reconnectCount(getDb(), workspaceId));
