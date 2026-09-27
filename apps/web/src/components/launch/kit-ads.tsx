import { AD_PLATFORMS, ADS_LIMITS, ADS_SPEND_STATEMENT, type AdCopyField, type AdsExportBody } from "@mkt/contracts";
import { CopyButton } from "@/components/publishing/copy-button";

const FIELDS: AdCopyField[] = ["primaryText", "headline", "description"];

/** The spend line, shown before anything else on the ads kit (§2.3 Ads, January: export only). */
export function AdsSpendBanner() {
  return (
    <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 px-4 py-3">
      <p className="font-medium text-emerald-200">{ADS_SPEND_STATEMENT}</p>
      <p className="mt-1 text-sm text-zinc-400">
        Nothing here turns an ad on. Create each ad paused, for people 18 and over, with a daily limit and an end date, then turn it on yourself.
      </p>
    </div>
  );
}

function Count({ text, max, recommended }: { text: string; max: number; recommended?: number }) {
  const n = text.length;
  const tone = n > max ? "text-red-400" : recommended !== undefined && n > recommended ? "text-amber-300" : "text-zinc-500";
  return (
    <span className={`text-xs ${tone}`}>
      {n}/{max}
      {recommended !== undefined && n > recommended && n <= max ? ` · may be cut after ${recommended}` : ""}
    </span>
  );
}

/** Read-only view of the ads export (it's edited by writing it again; the files are what you upload). */
export function AdsKitView({ body }: { body: AdsExportBody }) {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">3 ad ideas</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {body.concepts.map((c) => (
            <article key={c.idx} className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-sm">
              <p className="text-xs text-zinc-500">Idea {c.idx + 1}</p>
              <p className="font-medium">{c.angle}</p>
              <p className="text-zinc-200">&ldquo;{c.openingLine}&rdquo;</p>
              <p className="text-zinc-400">{c.visual.description}</p>
              {(c.visual.assetIds.length > 0 || c.visual.renderIds.length > 0) && (
                <p className="text-xs text-zinc-500">
                  Uses {c.visual.assetIds.length + c.visual.renderIds.length} of your screenshots or videos (in the zip).
                </p>
              )}
              <p className="text-xs text-zinc-500">Why: {c.why}</p>
            </article>
          ))}
        </div>
      </section>

      {body.budgetNote && <p className="text-sm text-zinc-400">{body.budgetNote}</p>}

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Text for each platform</h2>
        {AD_PLATFORMS.map((p) => {
          const exp = body.platforms[p];
          const lim = ADS_LIMITS[p];
          return (
            <details key={p} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4" open={!exp.skipped && p === "meta"}>
              <summary className="cursor-pointer font-medium">
                {lim.label}
                {exp.skipped ? <span className="ml-2 text-sm font-normal text-zinc-500">Left out: {exp.skipped}</span> : null}
              </summary>
              {!exp.skipped && (
                <div className="mt-3 flex flex-col gap-4 text-sm">
                  {exp.audience && <p className="text-zinc-400">Who to show it to: {exp.audience}</p>}
                  {exp.copy.map((v, i) => (
                    <div key={i} className="flex flex-col gap-2 rounded-md border border-zinc-800 p-3">
                      <p className="text-xs text-zinc-500">
                        Idea {v.conceptIdx + 1}, version {i + 1}
                        {v.callToAction ? ` · Button: ${v.callToAction}` : ""}
                      </p>
                      {FIELDS.map((f) => {
                        const spec = lim.fields[f];
                        const text = v[f];
                        if (!spec || !text) return null;
                        return (
                          <div key={f} className="flex flex-col gap-1">
                            <span className="flex items-baseline justify-between gap-2 text-xs text-zinc-500">
                              <span>{spec.label}</span>
                              <Count text={text} max={spec.max} {...(spec.recommended !== undefined ? { recommended: spec.recommended } : {})} />
                            </span>
                            <div className="flex items-start justify-between gap-2">
                              <p className="whitespace-pre-wrap text-zinc-200">{text}</p>
                              <CopyButton text={text} label="Copy" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {exp.keywords.length > 0 && (
                    <div>
                      <p className="text-xs text-zinc-500">Keywords</p>
                      <p className="text-zinc-300">{exp.keywords.join(", ")}</p>
                    </div>
                  )}
                  {exp.placements.length > 0 && (
                    <div>
                      <p className="text-xs text-zinc-500">Where it shows</p>
                      <ul className="mt-1 list-disc pl-5 text-zinc-400">
                        {exp.placements.map((pl) => (
                          <li key={pl.name}>
                            {pl.name} ({pl.aspect.replace("x", ":")}): {pl.notes}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </details>
          );
        })}
      </section>

      <AdsLimits />
    </div>
  );
}

/** Text limits per platform. Only X's 280 characters is checked; the rest are the platforms' public specs as last known. */
export function AdsLimits() {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">Text limits</h2>
      <p className="text-xs text-zinc-500">Over the first number the platform rejects the text; over the second it may cut it off. Check the platform before you upload.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 pr-4 font-normal">Platform</th>
              <th className="py-1 pr-4 font-normal">Main text</th>
              <th className="py-1 pr-4 font-normal">Headline</th>
              <th className="py-1 pr-4 font-normal">Description</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {AD_PLATFORMS.map((p) => {
              const l = ADS_LIMITS[p];
              const cell = (f: AdCopyField) => {
                const s = l.fields[f];
                return s ? `${s.label}: ${s.max}${s.recommended ? ` (${s.recommended})` : ""}` : "–";
              };
              return (
                <tr key={p} className="border-t border-zinc-800">
                  <td className="py-1 pr-4">{l.label}</td>
                  {l.keyword ? (
                    <td colSpan={3} className="py-1 pr-4 text-zinc-400">
                      Keywords up to {l.keyword.max} characters; the ad is your App Store listing.
                    </td>
                  ) : (
                    FIELDS.map((f) => (
                      <td key={f} className="py-1 pr-4">
                        {cell(f)}
                      </td>
                    ))
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
