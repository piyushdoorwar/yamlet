// Code snippets for a built request in several languages. Isomorphic.
import type { BuiltRequest } from "./requestBuilder.js";
import { encodeUrlEncodedBody } from "./requestBuilder.js";

export const SNIPPET_LANGUAGES: { id: string; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "http", label: "HTTP (raw)" },
  { id: "javascript-fetch", label: "JavaScript (fetch)" },
  { id: "node-axios", label: "Node.js (axios)" },
  { id: "python-requests", label: "Python (requests)" },
  { id: "go", label: "Go (net/http)" },
  { id: "csharp-httpclient", label: "C# (HttpClient)" },
  { id: "java-okhttp", label: "Java (OkHttp)" },
  { id: "php-curl", label: "PHP (cURL)" },
  { id: "powershell", label: "PowerShell" },
  { id: "ruby", label: "Ruby (Net::HTTP)" },
];

type Gen = (b: BuiltRequest) => string;

const q = (s: string) => JSON.stringify(s); // double-quoted literal valid in JS/Python/Java/C#/Go
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const phpq = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rbq = (s: string) => JSON.stringify(s).replace(/#\{/g, "\\#{");
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

const isContentType = (k: string) => k.toLowerCase() === "content-type";
const isUserAgent = (k: string) => k.toLowerCase() === "user-agent";
const contentTypeOf = (b: BuiltRequest) => b.headers.find((h) => isContentType(h.key))?.value;

/** Headers minus a Content-Type that would break multipart boundaries. */
function sendHeaders(b: BuiltRequest) {
  return b.headers.filter((h) => !(b.body.kind === "form-data" && isContentType(h.key)));
}

function textBody(b: BuiltRequest): string | undefined {
  if (b.body.kind === "text") return b.body.text;
  if (b.body.kind === "urlencoded") return encodeUrlEncodedBody(b.body.fields);
  return undefined;
}

const curl: Gen = (b) => {
  const lines: string[] = [];
  const first = `curl --location${b.method !== "GET" || b.body.kind !== "none" ? ` --request ${b.method}` : ""} ${shq(b.url)}`;
  for (const h of sendHeaders(b)) lines.push(`--header ${shq(`${h.key}: ${h.value}`)}`);
  switch (b.body.kind) {
    case "text":
      lines.push(`--data-raw ${shq(b.body.text)}`);
      break;
    case "urlencoded":
      for (const f of b.body.fields) lines.push(`--data-urlencode ${shq(`${f.key}=${f.value}`)}`);
      break;
    case "form-data":
      for (const f of b.body.fields) lines.push(`--form ${shq(`${f.key}=${f.isFile ? "@" + f.value : f.value}`)}`);
      break;
    case "binary":
      lines.push(`--data-binary ${shq("@" + b.body.file)}`);
      break;
  }
  return [first, ...lines].join(" \\\n  ");
};

const http: Gen = (b) => {
  let target = b.url;
  let host = "";
  try {
    const u = new URL(b.url);
    target = (u.pathname || "/") + u.search;
    host = u.host;
  } catch {
    /* unresolved URL: show as-is */
  }
  const lines = [`${b.method} ${target} HTTP/1.1`];
  if (host) lines.push(`Host: ${host}`);
  const boundary = "----YamletFormBoundary";
  for (const h of sendHeaders(b)) lines.push(`${h.key}: ${h.value}`);
  if (b.body.kind === "form-data") lines.push(`Content-Type: multipart/form-data; boundary=${boundary}`);
  let body = textBody(b);
  if (b.body.kind === "form-data") {
    const parts = b.body.fields.map((f) =>
      f.isFile
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${f.key}"; filename="${basename(f.value)}"\r\nContent-Type: application/octet-stream\r\n\r\n< ${f.value}`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${f.key}"\r\n\r\n${f.value}`,
    );
    body = [...parts, `--${boundary}--`].join("\r\n");
  } else if (b.body.kind === "binary") body = `< ${b.body.file}`;
  return lines.join("\n") + (body !== undefined ? `\n\n${body.replace(/\r\n/g, "\n")}` : "");
};

const jsFetch: Gen = (b) => {
  const out: string[] = [];
  const opts: string[] = [`  method: ${q(b.method)},`];
  const hs = sendHeaders(b);
  if (hs.length) opts.push(`  headers: {\n${hs.map((h) => `    ${q(h.key)}: ${q(h.value)},`).join("\n")}\n  },`);
  switch (b.body.kind) {
    case "text":
      opts.push(`  body: ${q(b.body.text)},`);
      break;
    case "urlencoded":
      out.push(`const body = new URLSearchParams([\n${b.body.fields.map((f) => `  [${q(f.key)}, ${q(f.value)}],`).join("\n")}\n]);`);
      opts.push("  body,");
      break;
    case "form-data":
      out.push("const body = new FormData();");
      for (const f of b.body.fields)
        out.push(f.isFile ? `body.append(${q(f.key)}, fileInput.files[0], ${q(basename(f.value))}); // ${f.value}` : `body.append(${q(f.key)}, ${q(f.value)});`);
      opts.push("  body,");
      break;
    case "binary":
      out.push(`const body = fileInput.files[0]; // ${b.body.file}`);
      opts.push("  body,");
      break;
  }
  if (out.length) out.push("");
  out.push(`const response = await fetch(${q(b.url)}, {\n${opts.join("\n")}\n});`);
  out.push("console.log(await response.text());");
  return out.join("\n");
};

const nodeAxios: Gen = (b) => {
  const out = ['const axios = require("axios");'];
  const cfg: string[] = [`  method: ${q(b.method.toLowerCase())},`, `  url: ${q(b.url)},`, "  maxRedirects: 10,"];
  const hs = sendHeaders(b).map((h) => `    ${q(h.key)}: ${q(h.value)},`);
  switch (b.body.kind) {
    case "text":
      cfg.push(`  data: ${q(b.body.text)},`);
      break;
    case "urlencoded":
      cfg.push(`  data: new URLSearchParams([\n${b.body.fields.map((f) => `    [${q(f.key)}, ${q(f.value)}],`).join("\n")}\n  ]).toString(),`);
      break;
    case "form-data":
      out.push('const FormData = require("form-data");');
      if (b.body.fields.some((f) => f.isFile)) out.push('const fs = require("fs");');
      out.push("", "const data = new FormData();");
      for (const f of b.body.fields)
        out.push(f.isFile ? `data.append(${q(f.key)}, fs.createReadStream(${q(f.value)}));` : `data.append(${q(f.key)}, ${q(f.value)});`);
      hs.push("    ...data.getHeaders(),");
      cfg.push("  data,");
      break;
    case "binary":
      out.push('const fs = require("fs");');
      cfg.push(`  data: fs.readFileSync(${q(b.body.file)}),`);
      break;
  }
  if (hs.length) cfg.splice(2, 0, `  headers: {\n${hs.join("\n")}\n  },`);
  out.push("", `axios.request({\n${cfg.join("\n")}\n})`);
  out.push("  .then((response) => console.log(JSON.stringify(response.data)))");
  out.push("  .catch((error) => console.error(error));");
  return out.join("\n");
};

const pythonRequests: Gen = (b) => {
  const out = ["import requests", "", `url = ${q(b.url)}`];
  const args = ["url"];
  const hs = sendHeaders(b);
  if (hs.length) {
    out.push(`headers = {\n${hs.map((h) => `    ${q(h.key)}: ${q(h.value)},`).join("\n")}\n}`);
    args.push("headers=headers");
  }
  switch (b.body.kind) {
    case "text":
      out.push(`payload = ${q(b.body.text)}`);
      args.push('data=payload.encode("utf-8")');
      break;
    case "urlencoded":
      out.push(`payload = [\n${b.body.fields.map((f) => `    (${q(f.key)}, ${q(f.value)}),`).join("\n")}\n]`);
      args.push("data=payload");
      break;
    case "form-data": {
      const text = b.body.fields.filter((f) => !f.isFile);
      const files = b.body.fields.filter((f) => f.isFile);
      out.push(`payload = [\n${text.map((f) => `    (${q(f.key)}, ${q(f.value)}),`).join("\n")}\n]`);
      args.push("data=payload");
      if (files.length) {
        out.push(`files = [\n${files.map((f) => `    (${q(f.key)}, (${q(basename(f.value))}, open(${q(f.value)}, "rb"))),`).join("\n")}\n]`);
        args.push("files=files");
      }
      break;
    }
    case "binary":
      out.push(`payload = open(${q(b.body.file)}, "rb")`);
      args.push("data=payload");
      break;
  }
  out.push("", `response = requests.request(${q(b.method)}, ${args.join(", ")})`, "", "print(response.text)");
  return out.join("\n");
};

const goNetHttp: Gen = (b) => {
  const imports = new Set(["fmt", "io", "net/http"]);
  const body: string[] = [];
  let payloadVar = "nil";
  const goStr = (s: string) => (s.includes("`") ? q(s) : "`" + s + "`");
  switch (b.body.kind) {
    case "text":
    case "urlencoded":
      imports.add("strings");
      body.push(`\tpayload := strings.NewReader(${goStr(textBody(b)!)})`);
      payloadVar = "payload";
      break;
    case "form-data":
      imports.add("bytes");
      imports.add("mime/multipart");
      body.push("\tpayload := &bytes.Buffer{}", "\twriter := multipart.NewWriter(payload)");
      for (const f of b.body.fields) {
        if (f.isFile) {
          imports.add("os");
          imports.add("path/filepath");
          // A block per file keeps `file`/`part` scoped so several file fields compile.
          body.push(
            "\t{",
            `\t\tfile, err := os.Open(${q(f.value)})`,
            "\t\tif err != nil {\n\t\t\tpanic(err)\n\t\t}",
            `\t\tpart, _ := writer.CreateFormFile(${q(f.key)}, filepath.Base(${q(f.value)}))`,
            "\t\tio.Copy(part, file)",
            "\t\tfile.Close()",
            "\t}",
          );
        } else body.push(`\twriter.WriteField(${q(f.key)}, ${q(f.value)})`);
      }
      body.push("\twriter.Close()");
      payloadVar = "payload";
      break;
    case "binary":
      imports.add("os");
      body.push(`\tpayload, err := os.Open(${q(b.body.file)})`, "\tif err != nil {\n\t\tpanic(err)\n\t}", "\tdefer payload.Close()");
      payloadVar = "payload";
      break;
  }
  body.push(
    `\treq, err := http.NewRequest(${q(b.method)}, ${q(b.url)}, ${payloadVar})`,
    "\tif err != nil {\n\t\tpanic(err)\n\t}",
  );
  for (const h of sendHeaders(b)) body.push(`\treq.Header.Add(${q(h.key)}, ${q(h.value)})`);
  if (b.body.kind === "form-data") body.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
  body.push(
    "\tres, err := http.DefaultClient.Do(req)",
    "\tif err != nil {\n\t\tpanic(err)\n\t}",
    "\tdefer res.Body.Close()",
    "\tdata, _ := io.ReadAll(res.Body)",
    "\tfmt.Println(string(data))",
  );
  const sortedImports = [...imports].sort().map((i) => `\t"${i}"`);
  return `package main\n\nimport (\n${sortedImports.join("\n")}\n)\n\nfunc main() {\n${body.join("\n")}\n}`;
};

const csharp: Gen = (b) => {
  const out = ["using var client = new HttpClient();", `var request = new HttpRequestMessage(new HttpMethod(${q(b.method)}), ${q(b.url)});`];
  const ct = contentTypeOf(b);
  for (const h of sendHeaders(b)) {
    if (isContentType(h.key)) continue;
    out.push(`request.Headers.TryAddWithoutValidation(${q(h.key)}, ${q(h.value)});`);
  }
  switch (b.body.kind) {
    case "text":
      out.push(`request.Content = new StringContent(${q(b.body.text)});`);
      if (ct) out.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${q(ct)});`);
      break;
    case "urlencoded":
      out.push(
        `request.Content = new FormUrlEncodedContent(new[]\n{\n${b.body.fields
          .map((f) => `    new KeyValuePair<string, string>(${q(f.key)}, ${q(f.value)}),`)
          .join("\n")}\n});`,
      );
      break;
    case "form-data":
      out.push("var content = new MultipartFormDataContent();");
      for (const f of b.body.fields)
        out.push(
          f.isFile
            ? `content.Add(new StreamContent(File.OpenRead(${q(f.value)})), ${q(f.key)}, ${q(basename(f.value))});`
            : `content.Add(new StringContent(${q(f.value)}), ${q(f.key)});`,
        );
      out.push("request.Content = content;");
      break;
    case "binary":
      out.push(`request.Content = new ByteArrayContent(File.ReadAllBytes(${q(b.body.file)}));`);
      if (ct) out.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${q(ct)});`);
      break;
  }
  out.push("var response = await client.SendAsync(request);", "Console.WriteLine(await response.Content.ReadAsStringAsync());");
  return out.join("\n");
};

const javaOkHttp: Gen = (b) => {
  const out = ["OkHttpClient client = new OkHttpClient().newBuilder().build();"];
  const ct = contentTypeOf(b);
  let bodyVar = "null";
  switch (b.body.kind) {
    case "text":
    case "urlencoded":
      out.push(`MediaType mediaType = MediaType.parse(${q(ct ?? "text/plain")});`);
      out.push(`RequestBody body = RequestBody.create(${q(textBody(b)!)}, mediaType);`);
      bodyVar = "body";
      break;
    case "form-data":
      out.push(
        "RequestBody body = new MultipartBody.Builder().setType(MultipartBody.FORM)\n" +
          b.body.fields
            .map((f) =>
              f.isFile
                ? `  .addFormDataPart(${q(f.key)}, ${q(basename(f.value))}, RequestBody.create(new File(${q(f.value)}), MediaType.parse("application/octet-stream")))`
                : `  .addFormDataPart(${q(f.key)}, ${q(f.value)})`,
            )
            .join("\n") +
          "\n  .build();",
      );
      bodyVar = "body";
      break;
    case "binary":
      out.push(`RequestBody body = RequestBody.create(new File(${q(b.body.file)}), MediaType.parse(${q(ct ?? "application/octet-stream")}));`);
      bodyVar = "body";
      break;
    default:
      if (["POST", "PUT", "PATCH"].includes(b.method)) {
        out.push('RequestBody body = RequestBody.create("", null);');
        bodyVar = "body";
      }
  }
  const builder = [`Request request = new Request.Builder()`, `  .url(${q(b.url)})`, `  .method(${q(b.method)}, ${bodyVar})`];
  for (const h of sendHeaders(b)) builder.push(`  .addHeader(${q(h.key)}, ${q(h.value)})`);
  builder.push("  .build();");
  out.push(builder.join("\n"), "Response response = client.newCall(request).execute();", "System.out.println(response.body().string());");
  return out.join("\n");
};

const phpCurl: Gen = (b) => {
  const opts = [
    `  CURLOPT_URL => ${phpq(b.url)},`,
    "  CURLOPT_RETURNTRANSFER => true,",
    "  CURLOPT_FOLLOWLOCATION => true,",
    "  CURLOPT_MAXREDIRS => 10,",
    `  CURLOPT_CUSTOMREQUEST => ${phpq(b.method)},`,
  ];
  switch (b.body.kind) {
    case "text":
    case "urlencoded":
      opts.push(`  CURLOPT_POSTFIELDS => ${phpq(textBody(b)!)},`);
      break;
    case "form-data":
      opts.push(
        `  CURLOPT_POSTFIELDS => [\n${b.body.fields
          .map((f) => `    ${phpq(f.key)} => ${f.isFile ? `new CURLFile(${phpq(f.value)})` : phpq(f.value)},`)
          .join("\n")}\n  ],`,
      );
      break;
    case "binary":
      opts.push(`  CURLOPT_POSTFIELDS => file_get_contents(${phpq(b.body.file)}),`);
      break;
  }
  const hs = sendHeaders(b);
  if (hs.length) opts.push(`  CURLOPT_HTTPHEADER => [\n${hs.map((h) => `    ${phpq(`${h.key}: ${h.value}`)},`).join("\n")}\n  ],`);
  return ["<?php", "", "$curl = curl_init();", "", `curl_setopt_array($curl, [\n${opts.join("\n")}\n]);`, "", "$response = curl_exec($curl);", "curl_close($curl);", "echo $response;"].join("\n");
};

const powershell: Gen = (b) => {
  const out: string[] = [];
  // Invoke-RestMethod's -Method only takes its built-in verbs; others need -CustomMethod.
  const builtIn = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "MERGE", "DEFAULT"].includes(b.method);
  const params = [psq(b.url), builtIn ? `-Method ${psq(b.method)}` : `-CustomMethod ${psq(b.method)}`];
  const ua = b.headers.find((h) => isUserAgent(h.key));
  const ct = contentTypeOf(b);
  const hs = sendHeaders(b).filter((h) => !isUserAgent(h.key) && !isContentType(h.key));
  if (hs.length) {
    out.push('$headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"');
    for (const h of hs) out.push(`$headers.Add(${psq(h.key)}, ${psq(h.value)})`);
    params.push("-Headers $headers");
  }
  if (ua) params.push(`-UserAgent ${psq(ua.value)}`);
  switch (b.body.kind) {
    case "text":
    case "urlencoded":
      out.push(`$body = @'\n${textBody(b)}\n'@`);
      params.push("-Body $body");
      if (ct) params.push(`-ContentType ${psq(ct)}`);
      break;
    case "form-data":
      out.push(
        `$form = @{\n${b.body.fields.map((f) => `  ${psq(f.key)} = ${f.isFile ? `Get-Item -Path ${psq(f.value)}` : psq(f.value)}`).join("\n")}\n}`,
      );
      params.push("-Form $form");
      break;
    case "binary":
      params.push(`-InFile ${psq(b.body.file)}`);
      if (ct) params.push(`-ContentType ${psq(ct)}`);
      break;
  }
  out.push(`$response = Invoke-RestMethod ${params.join(" ")}`, "$response | ConvertTo-Json");
  return out.join("\n");
};

const RUBY_CLASSES: Record<string, string> = {
  GET: "Get", POST: "Post", PUT: "Put", PATCH: "Patch", DELETE: "Delete", HEAD: "Head", OPTIONS: "Options",
};

const ruby: Gen = (b) => {
  const out = ['require "uri"', 'require "net/http"', "", `url = URI(${rbq(b.url)})`, "http = Net::HTTP.new(url.host, url.port)", 'http.use_ssl = url.scheme == "https"'];
  const cls = RUBY_CLASSES[b.method];
  out.push(cls ? `request = Net::HTTP::${cls}.new(url)` : `request = Net::HTTPGenericRequest.new(${rbq(b.method)}, true, true, url)`);
  for (const h of sendHeaders(b)) out.push(`request[${rbq(h.key)}] = ${rbq(h.value)}`);
  switch (b.body.kind) {
    case "text":
    case "urlencoded":
      out.push(`request.body = ${rbq(textBody(b)!)}`);
      break;
    case "form-data":
      out.push(
        `form_data = [\n${b.body.fields.map((f) => `  [${rbq(f.key)}, ${f.isFile ? `File.open(${rbq(f.value)})` : rbq(f.value)}],`).join("\n")}\n]`,
        'request.set_form form_data, "multipart/form-data"',
      );
      break;
    case "binary":
      out.push(`request.body = File.binread(${rbq(b.body.file)})`);
      break;
  }
  out.push("", "response = http.request(request)", "puts response.read_body");
  return out.join("\n");
};

const GENERATORS: Record<string, Gen> = {
  curl,
  http,
  "javascript-fetch": jsFetch,
  "node-axios": nodeAxios,
  "python-requests": pythonRequests,
  go: goNetHttp,
  "csharp-httpclient": csharp,
  "java-okhttp": javaOkHttp,
  "php-curl": phpCurl,
  powershell,
  ruby,
};

export function generateSnippet(lang: string, built: BuiltRequest): string {
  const gen = GENERATORS[lang];
  if (!gen) throw new Error(`Unknown snippet language: ${lang}`);
  return gen(built);
}
