import { connectTopviewMcp, normalizeError } from "./topviewMcp.mjs";

try {
  const client = await connectTopviewMcp();
  try {
    const tools = await client.listTools();
    const required = [
      "topview_get_generation_config",
      "topview_generate_image",
      "topview_generate_video",
      "topview_generate_music",
      "topview_generate_audio",
      "topview_generate_voice",
      "topview_remove_background",
      "topview_product_avatar",
      "topview_avatar_video",
      "topview_query_task"
    ];
    if (required.some((name) => !tools.includes(name))) process.exit(40);
    process.stdout.write("topview-mcp ready\n");
  } finally {
    await client.close();
  }
} catch (error) {
  const normalized = normalizeError(error);
  process.exit(normalized.exitCode);
}
