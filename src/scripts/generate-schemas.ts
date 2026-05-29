import fs from "node:fs";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DiffdocConfigSchema, RepoManifestSchema, SummaryAssetSchema } from "../schemas";

const SCHEMA_BASE_URL = "https://raw.githubusercontent.com/sullyTheDev/diffdoc";
const VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")).version as string;

interface SchemaEntry {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zodSchema: any;
}

const schemas: SchemaEntry[] = [
  { name: "diffdocrc.schema.json", zodSchema: DiffdocConfigSchema },
  { name: "manifest.schema.json", zodSchema: RepoManifestSchema },
  { name: "summary-asset.schema.json", zodSchema: SummaryAssetSchema }
];

const outDir = path.resolve(__dirname, "../../schemas");
fs.mkdirSync(outDir, { recursive: true });

for (const entry of schemas) {
  const jsonSchema = zodToJsonSchema(entry.zodSchema, {
    name: entry.name.replace(".schema.json", ""),
    $refStrategy: "none"
  }) as Record<string, unknown>;
  const schemaWithId = {
    ...jsonSchema,
    $id: `${SCHEMA_BASE_URL}/v${VERSION}/schemas/${entry.name}`
  };
  const outPath = path.resolve(outDir, entry.name);
  fs.writeFileSync(outPath, `${JSON.stringify(schemaWithId, null, 2)}\n`);
  console.log(`Generated: ${outPath}`);
}

console.log("Schema generation complete.");
