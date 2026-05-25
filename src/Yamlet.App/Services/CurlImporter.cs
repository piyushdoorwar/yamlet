using System.Text.RegularExpressions;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Parses a cURL command string into a <see cref="CurlImportResult"/> so the editor
/// can populate method, URL, headers, and body from a pasted cURL command.
/// </summary>
public static class CurlImporter
{
    private static readonly Regex TokenPattern = new(
        @"'(?:[^'\\]|\\.)*'|""(?:[^""\\]|\\.)*""|\S+",
        RegexOptions.Compiled);

    public static CurlImportResult? TryParse(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return null;
        }

        // Normalise line continuations and strip the leading "curl" token.
        var normalized = input
            .Replace("\\\r\n", " ")
            .Replace("\\\n", " ")
            .Replace("\\\r", " ")
            .Trim();

        var tokens = Tokenize(normalized);
        if (tokens.Count == 0)
        {
            return null;
        }

        // Must start with "curl".
        if (!string.Equals(tokens[0], "curl", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var result = new CurlImportResult();
        var i = 1;

        while (i < tokens.Count)
        {
            var token = tokens[i];

            if (token is "-X" or "--request" && i + 1 < tokens.Count)
            {
                result.Method = tokens[++i].ToUpperInvariant();
            }
            else if (token is "--url" && i + 1 < tokens.Count)
            {
                result.Url = tokens[++i];
            }
            else if (token is "-H" or "--header" && i + 1 < tokens.Count)
            {
                var raw = tokens[++i];
                var colon = raw.IndexOf(':', StringComparison.Ordinal);
                if (colon > 0)
                {
                    var key = raw[..colon].Trim();
                    var value = raw[(colon + 1)..].Trim();
                    result.Headers.Add(new YamletHeader { Key = key, Value = value, Enabled = true });
                }
            }
            else if (token is "-d" or "--data" or "--data-raw" or "--data-ascii" && i + 1 < tokens.Count)
            {
                result.Body = tokens[++i];
                result.BodyType = YamletBodyType.Raw;
            }
            else if (token is "--data-binary" && i + 1 < tokens.Count)
            {
                result.Body = tokens[++i];
                result.BodyType = YamletBodyType.Raw;
            }
            else if (token is "-F" or "--form" && i + 1 < tokens.Count)
            {
                var pair = tokens[++i];
                var eq = pair.IndexOf('=', StringComparison.Ordinal);
                if (eq > 0)
                {
                    result.FormFields.Add(new YamletBodyField
                    {
                        Key = pair[..eq],
                        Value = pair[(eq + 1)..],
                        Enabled = true,
                        IsFile = pair[(eq + 1)..].StartsWith('@'),
                    });
                    result.BodyType = YamletBodyType.FormData;
                }
            }
            else if (token is "-u" or "--user" && i + 1 < tokens.Count)
            {
                var creds = tokens[++i];
                var colon = creds.IndexOf(':', StringComparison.Ordinal);
                result.BasicUsername = colon >= 0 ? creds[..colon] : creds;
                result.BasicPassword = colon >= 0 ? creds[(colon + 1)..] : string.Empty;
            }
            else if (token is "-b" or "--cookie" && i + 1 < tokens.Count)
            {
                result.Cookie = tokens[++i];
            }
            else if (token is "--compressed" or "-s" or "--silent" or
                     "-k" or "--insecure" or "-v" or "--verbose" or
                     "-L" or "--location" or "--no-buffer")
            {
                if (token is "-k" or "--insecure")
                {
                    result.SkipSslVerification = true;
                }
                // Other flags are no-ops for import purposes.
            }
            else if (!token.StartsWith('-'))
            {
                // Bare positional argument is the URL.
                if (string.IsNullOrEmpty(result.Url))
                {
                    result.Url = token;
                }
            }

            i++;
        }

        if (string.IsNullOrEmpty(result.Url))
        {
            return null;
        }

        // Infer method from body presence if not set explicitly.
        if (string.IsNullOrEmpty(result.Method))
        {
            result.Method = (!string.IsNullOrEmpty(result.Body) || result.FormFields.Count > 0)
                ? "POST"
                : "GET";
        }

        // Detect JSON body type from Content-Type header.
        if (result.BodyType == YamletBodyType.Raw)
        {
            var ct = result.Headers
                .FirstOrDefault(h => string.Equals(h.Key, "Content-Type", StringComparison.OrdinalIgnoreCase))
                ?.Value ?? string.Empty;
            if (ct.Contains("application/json", StringComparison.OrdinalIgnoreCase))
            {
                result.BodyType = YamletBodyType.Json;
            }
        }

        // Promote Authorization header to auth fields.
        var authHeader = result.Headers
            .FirstOrDefault(h => string.Equals(h.Key, "Authorization", StringComparison.OrdinalIgnoreCase));
        if (authHeader is not null && authHeader.Value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            result.BearerToken = authHeader.Value["Bearer ".Length..].Trim();
            result.Headers.Remove(authHeader);
        }

        return result;
    }

    private static List<string> Tokenize(string input)
    {
        var tokens = new List<string>();
        foreach (Match m in TokenPattern.Matches(input))
        {
            var t = m.Value;
            // Strip surrounding single or double quotes.
            if (t.Length >= 2 && ((t[0] == '\'' && t[^1] == '\'') || (t[0] == '"' && t[^1] == '"')))
            {
                t = t[1..^1];
            }
            tokens.Add(t);
        }
        return tokens;
    }
}

public sealed class CurlImportResult
{
    public string Url { get; set; } = string.Empty;
    public string Method { get; set; } = string.Empty;
    public List<YamletHeader> Headers { get; } = new();
    public string Body { get; set; } = string.Empty;
    public YamletBodyType BodyType { get; set; } = YamletBodyType.None;
    public List<YamletBodyField> FormFields { get; } = new();
    public string BasicUsername { get; set; } = string.Empty;
    public string BasicPassword { get; set; } = string.Empty;
    public string BearerToken { get; set; } = string.Empty;
    public string Cookie { get; set; } = string.Empty;
    public bool SkipSslVerification { get; set; }
}
