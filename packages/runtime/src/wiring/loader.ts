import type { z } from "zod";
import { type Wiring, WiringSchema } from "./schema";

export class WiringValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: z.core.$ZodIssue[],
  ) {
    super(
      `invalid wiring file ${file}:\n${issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`,
    );
    this.name = "WiringValidationError";
  }
}

export async function loadWiringFile(path: string): Promise<Wiring> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (err) {
    throw new Error(`failed to parse JSON at ${path}: ${err}`);
  }

  const result = WiringSchema.safeParse(raw);
  if (!result.success)
    throw new WiringValidationError(path, result.error.issues);
  return result.data;
}
