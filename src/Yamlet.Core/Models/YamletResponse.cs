namespace Yamlet.App.Models;

/// <summary>
/// The result of executing a request: status, timing, headers and body. Also used to
/// surface transport-level failures via <see cref="IsError"/> / <see cref="ErrorMessage"/>.
/// </summary>
public sealed class YamletResponse
{
    public int StatusCode { get; set; }
    public string ReasonPhrase { get; set; } = string.Empty;
    public long DurationMs { get; set; }
    public long SizeBytes { get; set; }

    /// <summary>The fully-resolved request URL actually sent (variables expanded, query
    /// params applied, plus any script mutation). Empty if the request never got that far.</summary>
    public string ResolvedUrl { get; set; } = string.Empty;

    public List<YamletHeader> Headers { get; set; } = new();
    public string Body { get; set; } = string.Empty;

    /// <summary>Readable console snapshot of the exact resolved request and response.</summary>
    public string ConsoleText { get; set; } = string.Empty;

    /// <summary>Content-Type of the response body, when reported by the server.</summary>
    public string ContentType { get; set; } = string.Empty;

    /// <summary>True when the request never produced an HTTP response (DNS, timeout, etc.).</summary>
    public bool IsError { get; set; }
    public string? ErrorMessage { get; set; }

    public static YamletResponse FromError(string message, long durationMs) => new()
    {
        IsError = true,
        ErrorMessage = message,
        DurationMs = durationMs,
        ReasonPhrase = "Error",
    };
}
