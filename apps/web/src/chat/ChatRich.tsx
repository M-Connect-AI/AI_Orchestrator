import type {
  ChatBlock,
  ChatChartItem,
  ChatHighlight,
  ChatKpiItem,
  ChatKpiTone,
  ChatListItem,
} from "@msb/shared";

export function HighlightedText({
  text,
  highlights,
}: {
  text: string;
  highlights?: ChatHighlight[];
}) {
  if (!highlights?.length) return <>{text}</>;
  const valid = highlights.filter((h) => h.end > h.start && h.start >= 0 && h.end <= text.length);
  if (valid.length !== highlights.length) return <>{text}</>;
  const sorted = [...valid].sort((a, b) => a.start - b.start);
  const parts: { key: number; slice: string; kind?: ChatHighlight["kind"]; tone?: ChatKpiTone }[] = [];
  let cursor = 0;
  sorted.forEach((h, i) => {
    if (h.start < cursor) return;
    if (h.start > cursor) parts.push({ key: cursor, slice: text.slice(cursor, h.start) });
    parts.push({
      key: h.start + i,
      slice: text.slice(h.start, h.end),
      kind: h.kind,
      tone: h.tone,
    });
    cursor = h.end;
  });
  if (cursor < text.length) parts.push({ key: cursor, slice: text.slice(cursor) });
  return (
    <>
      {parts.map((p) =>
        p.kind ? (
          <mark key={p.key} className={highlightClass(p.kind, p.tone)}>
            {p.slice}
          </mark>
        ) : (
          <span key={p.key}>{p.slice}</span>
        ),
      )}
    </>
  );
}

export function ChatBlocks({
  blocks,
  onAction,
}: {
  blocks: ChatBlock[];
  onAction?: (url: string) => void;
}) {
  if (!blocks.length) return null;
  return (
    <div className="mt-3 space-y-3">
      {blocks.map((b, i) => (
        <div key={`${b.type}-${i}`}>{renderBlock(b, onAction)}</div>
      ))}
    </div>
  );
}

function renderBlock(block: ChatBlock, onAction?: (url: string) => void) {
  switch (block.type) {
    case "kpis":
      return <KpiRow items={block.items} />;
    case "bars":
      return <BarChart title={block.title} items={block.items} />;
    case "donut":
      return <Donut title={block.title} items={block.items} />;
    case "progress":
      return (
        <ProgressBar
          title={block.title}
          value={block.value}
          max={block.max}
          suffix={block.suffix}
        />
      );
    case "list":
      return <EntityList title={block.title} items={block.items} onAction={onAction} />;
    case "quote":
      return <Quote title={block.title} text={block.text} source={block.source} />;
    default:
      return null;
  }
}

function KpiRow({ items }: { items: ChatKpiItem[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-2xl bg-white border border-msb-mist px-3 py-2.5 shadow-sm"
        >
          <div className="text-[11px] text-stone-500 leading-tight">{it.label}</div>
          <div className={`mt-1 text-lg font-semibold tracking-tight ${toneText(it.tone)}`}>
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function BarChart({ title, items }: { title: string; items: ChatChartItem[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="rounded-2xl bg-white border border-msb-mist p-3 shadow-sm">
      <div className="text-xs font-semibold text-msb-ink mb-2">{title}</div>
      <div className="space-y-2">
        {items.map((it) => (
          <div key={it.label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 items-center">
            <div className="text-[11px] text-stone-600 truncate">{it.label}</div>
            <div className="text-[11px] font-semibold text-msb-ink tabular-nums">{it.value}</div>
            <div className="col-span-2 h-2 rounded-full bg-msb-mist overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: it.value <= 0 ? "0%" : `${Math.max(6, (it.value / max) * 100)}%`,
                  background: it.color || "#F15A22",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Donut({ title, items }: { title: string; items: ChatChartItem[] }) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  let acc = 0;
  const stops = items.map((it) => {
    const start = (acc / total) * 360;
    acc += it.value;
    const end = (acc / total) * 360;
    return `${it.color || "#F15A22"} ${start}deg ${end}deg`;
  });
  return (
    <div className="rounded-2xl bg-white border border-msb-mist p-3 shadow-sm">
      <div className="text-xs font-semibold text-msb-ink mb-3">{title}</div>
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div
          className="w-28 h-28 rounded-full shrink-0 relative"
          style={{ background: `conic-gradient(${stops.join(",")})` }}
          aria-hidden
        >
          <div className="absolute inset-[18px] rounded-full bg-white grid place-items-center">
            <span className="text-lg font-semibold text-msb-ink tabular-nums">{total}</span>
          </div>
        </div>
        <ul className="w-full space-y-1.5 text-xs">
          {items.map((it) => (
            <li key={it.label} className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: it.color || "#F15A22" }}
              />
              <span className="flex-1 text-stone-600 truncate">{it.label}</span>
              <span className="font-semibold text-msb-ink tabular-nums">{it.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProgressBar({
  title,
  value,
  max,
  suffix,
}: {
  title: string;
  value: number;
  max: number;
  suffix?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="rounded-2xl bg-white border border-msb-mist p-3 shadow-sm">
      <div className="flex justify-between gap-2 text-xs mb-2">
        <span className="font-semibold text-msb-ink">{title}</span>
        <span className="text-stone-500 tabular-nums">
          {value}/{max}
          {suffix ? ` ${suffix}` : ""} · {pct}%
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-msb-mist overflow-hidden">
        <div className="h-full rounded-full bg-msb-orange" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
    </div>
  );
}

function EntityList({
  title,
  items,
  onAction,
}: {
  title?: string;
  items: ChatListItem[];
  onAction?: (url: string) => void;
}) {
  return (
    <div className="rounded-2xl bg-white border border-msb-mist overflow-hidden shadow-sm">
      {title ? (
        <div className="px-3 py-2 text-xs font-semibold text-msb-ink border-b border-msb-mist">
          {title}
        </div>
      ) : null}
      <ul className="divide-y divide-msb-mist">
        {items.map((it, i) => (
          <li key={`${it.title}-${i}`}>
            {it.url ? (
              <button
                type="button"
                className={`w-full text-left px-3 py-2.5 hover:bg-msb-cream/80 ${
                  it.tone === "warn" ? "border-l-2 border-l-msb-orange" : ""
                }`}
                onClick={() => onAction?.(it.url!)}
              >
                <ListBody item={it} />
              </button>
            ) : (
              <div
                className={`px-3 py-2.5 ${it.tone === "warn" ? "border-l-2 border-l-msb-orange" : ""}`}
              >
                <ListBody item={it} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ListBody({ item }: { item: ChatListItem }) {
  const initial = (item.kicker || item.title).trim().charAt(0).toUpperCase();
  return (
    <div className="flex items-start gap-2.5">
      {item.kicker ? (
        <div className="w-8 h-8 rounded-full bg-msb-cream text-msb-orange text-xs font-semibold grid place-items-center shrink-0 mt-0.5">
          {initial}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        {item.kicker ? (
          <div className="text-[11px] text-stone-500 truncate">{item.kicker}</div>
        ) : null}
        <div className="text-sm font-medium text-msb-ink leading-snug">{item.title}</div>
        {item.subtitle ? (
          <div className="text-[11px] text-stone-500 mt-0.5 leading-snug line-clamp-2">{item.subtitle}</div>
        ) : null}
      </div>
      {item.badge ? (
        <span className={`shrink-0 mt-0.5 text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeClass(item.tone)}`}>
          {item.badge}
        </span>
      ) : null}
    </div>
  );
}

function Quote({ title, text, source }: { title: string; text: string; source?: string }) {
  return (
    <blockquote className="rounded-2xl bg-msb-cream border border-msb-mist border-l-4 border-l-msb-orange px-3 py-2.5">
      <div className="text-[11px] font-semibold text-msb-orange">{title}</div>
      <p className="text-sm text-msb-ink mt-1 leading-relaxed">{text}</p>
      {source ? <div className="text-[10px] text-stone-400 mt-1.5">{source}</div> : null}
    </blockquote>
  );
}

function highlightClass(kind: ChatHighlight["kind"], tone?: ChatKpiTone) {
  switch (kind) {
    case "metric":
      return "bg-transparent text-msb-orange font-semibold p-0";
    case "date":
      return "bg-msb-mist text-msb-ink font-medium px-0.5 rounded";
    case "status":
      return statusHighlightClass(tone);
    case "id":
      return "bg-msb-mist text-msb-ink font-mono text-[0.85em] px-1 rounded";
    case "warn":
      return "bg-red-50 text-red-700 font-medium px-1 rounded";
    default:
      return "bg-msb-mist";
  }
}

function statusHighlightClass(tone?: ChatKpiTone) {
  if (tone === "ok") return "bg-emerald-50 text-emerald-700 font-medium px-1.5 py-0.5 rounded-full";
  if (tone === "bad") return "bg-red-50 text-red-700 font-medium px-1.5 py-0.5 rounded-full";
  if (tone === "neutral") return "bg-stone-100 text-stone-600 font-medium px-1.5 py-0.5 rounded-full";
  return "bg-orange-50 text-msb-orange-deep font-medium px-1.5 py-0.5 rounded-full";
}

function toneText(tone?: ChatKpiTone) {
  if (tone === "bad") return "text-red-600";
  if (tone === "warn") return "text-msb-orange-deep";
  if (tone === "ok") return "text-msb-orange";
  return "text-msb-ink";
}

function badgeClass(tone?: ChatKpiTone) {
  if (tone === "bad") return "bg-red-50 text-red-700";
  if (tone === "warn") return "bg-orange-50 text-msb-orange-deep";
  if (tone === "ok") return "bg-emerald-50 text-emerald-700";
  return "bg-msb-mist text-stone-600";
}
