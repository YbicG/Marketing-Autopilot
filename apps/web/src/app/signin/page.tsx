import { SignInButton } from "./sign-in-button";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Marketing Autopilot</h1>
        <p className="mt-2 text-sm text-zinc-400">Drop in a link to your product and get a campaign you can review.</p>
      </div>
      <SignInButton />
      <p className="text-xs text-zinc-500">Only invited GitHub accounts can sign in.</p>
    </main>
  );
}
