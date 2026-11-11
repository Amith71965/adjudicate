import type { z } from "zod";
import type { letterPacketSchema } from "@/lib/schemas/letter_packet.zod";
import type { letterReviewSchema } from "@/lib/schemas/letter_review.zod";

export type LetterPacket = z.infer<typeof letterPacketSchema>;
export type Letter = LetterPacket["letters"][number];
export type LetterReview = z.infer<typeof letterReviewSchema>;
export type SentenceLabel = LetterReview["sentences"][number]["label"];
