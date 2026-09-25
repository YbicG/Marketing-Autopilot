import { redirect } from "next/navigation";

/** A project opens on Today (§2.2). */
export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/p/${encodeURIComponent(slug)}/today`);
}
