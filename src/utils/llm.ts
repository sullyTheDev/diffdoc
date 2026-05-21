import OpenAI from "openai";
import type { ChatConfig, EmbeddingConfig } from "../config";

function createClient(config: ChatConfig): { client: OpenAI; model: string } {
  return {
    client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }),
    model: config.model
  };
}

export async function generateFunctionalSummary(fileName: string, codeContent: string, config: ChatConfig): Promise<string> {
  const { client, model } = createClient(config);
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "Explain what this code does for non-technical stakeholders. Focus on business behavior, user impact, rules, data movement, and visible outcomes. Use plain English, avoid jargon, and provide zero conversational preamble."
      },
      {
        role: "user",
        content: `File: ${fileName}\n\nCode:\n${codeContent}`
      }
    ]
  });

  return response.choices[0]?.message?.content?.trim() || "No business behavior summary was returned.";
}

export async function promptLlm(prompt: string, config: ChatConfig): Promise<string> {
  const { client, model } = createClient(config);
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return response.choices[0]?.message?.content?.trim() || "No response was returned.";
}

export async function generateEmbeddings(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  const baseURL = config.baseURL.replace(/\/embeddings\/?$/, "");
  const client = new OpenAI({ apiKey: config.apiKey, baseURL });
  const response = await client.embeddings.create({
    model: config.model,
    input: texts
  });

  return response.data.map((item) => item.embedding);
}
