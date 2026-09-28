import { StatePage } from "@/components/shell/state-page";

export const metadata = { title: "Not found · Marketing Autopilot" };

/** Any URL that matches nothing. Sits outside the app frame, like sign-in. */
export default function NotFound() {
  return <StatePage centered title="Nothing here" body="That page doesn't exist, or it moved. Your projects are all on Home." />;
}
