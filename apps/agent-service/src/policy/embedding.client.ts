import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

type Extractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

const importEsm = new Function("m", "return import(m)") as (m: string) => Promise<any>;

function embeddingModelName(override?: string) {
  return (
    override?.trim() ||
    process.env.EMBEDDING_MODEL?.trim() ||
    "Xenova/multilingual-e5-small"
  );
}

async function getLocalExtractor(model: string): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const mod = await importEsm("@xenova/transformers");
      return (await mod.pipeline("feature-extraction", model)) as Extractor;
    })();
  }
  return extractorPromise;
}

/**
 * Embed bằng model local (mặc định Xenova/multilingual-e5-small).
 * e5: document dùng prefix "passage:", query dùng "query:".
 */
export async function embedTexts(
  texts: string[],
  opts: { model?: string; asQuery?: boolean } = {},
): Promise<number[][]> {
  if (!texts.length) return [];
  const model = embeddingModelName(opts.model);
  const extractor = await getLocalExtractor(model);
  const prefix = opts.asQuery ? "query: " : "passage: ";
  const vectors: number[][] = [];
  for (const text of texts) {
    const out = await extractor(`${prefix}${text}`, { pooling: "mean", normalize: true });
    vectors.push(Array.from(out.data));
  }
  return vectors;
}

@Injectable()
export class EmbeddingClient {
  private readonly log = new Logger(EmbeddingClient.name);

  constructor(private readonly config: ConfigService) {}

  model() {
    return (
      this.config.get<string>("EMBEDDING_MODEL")?.trim() ||
      "Xenova/multilingual-e5-small"
    );
  }

  async embed(texts: string[], asQuery = false): Promise<number[][]> {
    this.log.debug(`embed ${texts.length} text(s) via ${this.model()}`);
    return embedTexts(texts, { model: this.model(), asQuery });
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embed([text], true);
    return v;
  }
}
