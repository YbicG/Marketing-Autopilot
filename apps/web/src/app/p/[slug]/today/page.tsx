import { redirect } from "next/navigation";

/** Today moved into the project Overview; keep old links working. */
export default async function TodayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/p/${encodeURIComponent(slug)}`);
}
