// Turning a finished job into a webhook body. Pure functions only, so the
// server can post them and the tests can inspect them without a network.
//
// Discord gets an embed: the source site as a small author line, the title as
// a link back to the source, the artist under it, two inline facts and the
// cover as a thumbnail. Slack gets a header plus a context line; everything
// else keeps the generic {"content": "..."} body. Mentions are disabled by the
// caller: a track called "@everyone" must not ping a server.

export function clip(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

// Same limit, but keeps the line breaks: the plain-text body is read in a
// notification, where one long line is harder to scan than two.
export function clipLines(value, max) {
  const text = String(value ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

const COLORS = { done: 0x4c9a52, partial: 0xd29922, failed: 0xe5534b };

export function notificationColor(message) {
  if (message.state === "failed") return COLORS.failed;
  return message.failed || message.skipped ? COLORS.partial : COLORS.done;
}

// The small line above a Discord title: where the file came from.
export function sourceHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function notificationText(message) {
  const lines = [`**${message.title}**${message.subtitle ? ` - ${message.subtitle}` : ""}`];
  lines.push(`${message.summary} · ${message.format}`);
  if (message.error) lines.push(message.error);
  if (message.url) lines.push(message.url);
  return lines.join("\n");
}

// Discord limits: title 256, description 4096, field value 1024, footer 2048.
export function discordEmbed(message) {
  const host = sourceHost(message.url);
  const saved = Number(message.saved) || 0;
  const fields = [];
  // A failure that saved nothing is explained by its description; a count of
  // zero next to it would only add noise.
  if (saved > 0 || message.state !== "failed") {
    fields.push({ name: "Tracks", value: clip(message.summary, 1024), inline: true });
  }
  fields.push({ name: "Format", value: clip(message.format, 1024), inline: true });
  const embed = {
    title: clip(message.title, 256),
    color: notificationColor(message),
    fields,
    footer: { text: clip(`${message.site} · ${message.guest ? "guest" : "library"}`, 2048) },
    timestamp: new Date(message.finishedAt).toISOString(),
  };
  if (host) embed.author = { name: clip(host, 256) };
  if (message.url) embed.url = message.url;
  // The error is the point of a failure notification, so it goes up front.
  const body = [message.subtitle, message.error].filter(Boolean).join("\n\n");
  if (body) embed.description = body.slice(0, 4096);
  if (message.thumb) embed.thumbnail = { url: message.thumb };
  return embed;
}

// Slack's mrkdwn: a header block plus one context line. `text` stays as the
// notification/fallback copy for clients that do not render blocks.
export function slackPayload(message) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: clip(message.title, 150), emoji: false } },
  ];
  if (message.subtitle) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(message.subtitle, 2900) } });
  }
  const host = sourceHost(message.url);
  const context = [message.summary, message.format, message.error, host ? `via ${host}` : ""]
    .filter(Boolean)
    .join(" · ");
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(context, 2900) }] });
  return { text: clipLines(notificationText(message), 2900), blocks };
}

export function webhookKind(url) {
  let host = "";
  try {
    host = new URL(String(url)).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "generic";
  }
  if (/(^|\.)discord(app)?\.com$/.test(host)) return "discord";
  if (host === "hooks.slack.com") return "slack";
  return "generic";
}

export function webhookPayload(kind, message) {
  if (kind === "discord") {
    return {
      body: JSON.stringify({ embeds: [discordEmbed(message)], allowed_mentions: { parse: [] } }),
    };
  }
  if (kind === "slack") return { body: JSON.stringify(slackPayload(message)) };
  return {
    body: JSON.stringify({
      content: clipLines(notificationText(message), 1900),
      allowed_mentions: { parse: [] },
    }),
  };
}
