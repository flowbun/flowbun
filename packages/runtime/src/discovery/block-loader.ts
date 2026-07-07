import { join, relative } from "node:path";
import type { AnyBlockDef } from "../block";
import hassAction from "../hass/action";
import hassTrigger from "../hass/trigger";
import type { BlockRegistry } from "../wiring/flow-assembly";

export class BlockDiscoveryError extends Error {}

function isBlockDef(
  mod: Record<string, unknown>,
): mod is { default: AnyBlockDef } {
  const def = mod.default as Partial<AnyBlockDef> | undefined;
  return (
    typeof def === "object" &&
    def !== null &&
    typeof def.name === "string" &&
    typeof def.process === "function" &&
    typeof def.inputs === "object" &&
    typeof def.outputs === "object"
  );
}

/** Scans `<dataDir>/blocks/*.ts`, dynamic-importing each and registering the two built-in @hass/* blocks. */
export async function discoverBlocks(dataDir: string): Promise<BlockRegistry> {
  const registry: BlockRegistry = new Map();
  registry.set("@hass/trigger", {
    def: hassTrigger,
    specifier: "flowbun/hass/trigger",
  });
  registry.set("@hass/action", {
    def: hassAction,
    specifier: "flowbun/hass/action",
  });

  const blocksDir = join(dataDir, "blocks");
  const generatedDir = join(dataDir, "generated");
  const glob = new Bun.Glob("*.ts");

  for await (const file of glob.scan({ cwd: blocksDir })) {
    const absPath = join(blocksDir, file);
    const mod = await import(absPath);
    if (!isBlockDef(mod)) {
      throw new BlockDiscoveryError(
        `${absPath} does not have a valid defineBlock default export`,
      );
    }
    const relSpecifier = relative(generatedDir, absPath).replace(/\.ts$/, "");
    registry.set(mod.default.name, {
      def: mod.default,
      specifier: relSpecifier.startsWith(".")
        ? relSpecifier
        : `./${relSpecifier}`,
    });
  }

  return registry;
}
