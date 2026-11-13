/**
 * Semantic icons. Every status and item kind carries a glyph as well as a colour, so meaning
 * never rests on colour alone. Glyphs come from lucide-react; data-icon names the glyph.
 */
import {
  CircleCheck, CircleDashed, CircleMinus, FileWarning, ScanSearch, ShieldAlert, type LucideIcon,
} from "lucide-react";
import type { ReviewItem } from "@/lib/review/cases";
import type { ItemStatus } from "@/lib/review/state";

const STATUS: Record<ItemStatus, { icon: LucideIcon; name: string; label: string }> = {
  open: { icon: CircleDashed, name: "circle-dashed", label: "Open" },
  resolved: { icon: CircleCheck, name: "circle-check", label: "Resolved" },
  dismissed: { icon: CircleMinus, name: "circle-minus", label: "Dismissed" },
};

const KIND: Record<ReviewItem["kind"], { icon: LucideIcon; name: string; label: string }> = {
  prong: { icon: ShieldAlert, name: "shield-alert", label: "AI objection" },
  waiver: { icon: FileWarning, name: "file-warning", label: "Waiver check" },
  manual: { icon: ScanSearch, name: "scan-search", label: "Not reviewed" },
};

interface Props {
  decorative?: boolean; // a visible text label sits next to it
  size?: number;
  className?: string;
}

function Glyph({ icon: Icon, name, label, decorative, size = 16, className }: Props & { icon: LucideIcon; name: string; label: string }) {
  return decorative ? (
    <Icon data-icon={name} aria-hidden="true" focusable="false" width={size} height={size} className={className} />
  ) : (
    <Icon data-icon={name} role="img" aria-label={label} aria-hidden={false} focusable="false" width={size} height={size} className={className} />
  );
}

export const StatusIcon = ({ status, ...p }: Props & { status: ItemStatus }) => <Glyph {...STATUS[status]} {...p} />;
export const KindIcon = ({ kind, ...p }: Props & { kind: ReviewItem["kind"] }) => <Glyph {...KIND[kind]} {...p} />;
export const kindLabel = (kind: ReviewItem["kind"]) => KIND[kind].label;
