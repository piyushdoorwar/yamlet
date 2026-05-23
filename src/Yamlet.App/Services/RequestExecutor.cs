using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Executes a <see cref="YamletRequest"/> over HTTP after resolving its variables.
/// The <see cref="HttpClient"/> is injected so tests can supply a fake handler.
/// </summary>
public sealed class RequestExecutor
{
    private readonly HttpClient _client;
    private readonly VariableResolver _resolver;

    public RequestExecutor(HttpClient client, VariableResolver resolver)
    {
        _client = client;
        _resolver = resolver;
    }

    /// <summary>Creates an executor backed by a default client with a sensible timeout.</summary>
    public static RequestExecutor CreateDefault() =>
        new(new HttpClient { Timeout = TimeSpan.FromSeconds(100) }, new VariableResolver());

    public async Task<YamletResponse> ExecuteAsync(
        YamletRequest request,
        VariableContext context,
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            using var message = BuildMessage(request, context);
            using var response = await _client
                .SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            stopwatch.Stop();

            return new YamletResponse
            {
                StatusCode = (int)response.StatusCode,
                ReasonPhrase = response.ReasonPhrase ?? string.Empty,
                DurationMs = stopwatch.ElapsedMilliseconds,
                SizeBytes = bytes.LongLength,
                ContentType = response.Content.Headers.ContentType?.ToString() ?? string.Empty,
                Body = DecodeBody(bytes, response.Content.Headers),
                Headers = CollectHeaders(response),
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            stopwatch.Stop();
            return YamletResponse.FromError("Request was cancelled.", stopwatch.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            return YamletResponse.FromError(ex.Message, stopwatch.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// Builds the outgoing <see cref="HttpRequestMessage"/> from a request and context.
    /// Exposed internally so tests can assert on the resolved message shape.
    /// </summary>
    internal HttpRequestMessage BuildMessage(YamletRequest request, VariableContext context)
    {
        var url = BuildUrl(request, context);
        var message = new HttpRequestMessage(new HttpMethod(request.Method.ToUpperInvariant()), url);

        ApplyBody(request, context, message);
        ApplyHeaders(request, context, message);
        ApplyAuth(request, context, message);

        return message;
    }

    private string BuildUrl(YamletRequest request, VariableContext context)
    {
        var baseUrl = _resolver.Resolve(request.Url, context).Trim();

        var enabledParams = request.QueryParams
            .Where(p => p.Enabled && !string.IsNullOrWhiteSpace(p.Key))
            .Select(p => (
                Key: _resolver.Resolve(p.Key, context),
                Value: _resolver.Resolve(p.Value, context)))
            .ToList();

        if (enabledParams.Count == 0)
        {
            return baseUrl;
        }

        var query = string.Join("&", enabledParams.Select(p =>
            $"{Uri.EscapeDataString(p.Key)}={Uri.EscapeDataString(p.Value)}"));

        var separator = baseUrl.Contains('?') ? "&" : "?";
        return baseUrl + separator + query;
    }

    private void ApplyHeaders(YamletRequest request, VariableContext context, HttpRequestMessage message)
    {
        foreach (var header in request.Headers.Where(h => h.Enabled && !string.IsNullOrWhiteSpace(h.Key)))
        {
            var key = _resolver.Resolve(header.Key, context);
            var value = _resolver.Resolve(header.Value, context);

            // Content headers (e.g. Content-Type) must be set on the content, not the
            // request, so fall back to the content collection when the request rejects them.
            if (!message.Headers.TryAddWithoutValidation(key, value))
            {
                message.Content?.Headers.TryAddWithoutValidation(key, value);
            }
        }
    }

    private void ApplyAuth(YamletRequest request, VariableContext context, HttpRequestMessage message)
    {
        var auth = request.Auth;
        switch (auth.Type)
        {
            case YamletAuthType.Bearer:
                var token = _resolver.Resolve(auth.Token, context);
                if (!string.IsNullOrWhiteSpace(token))
                {
                    message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                }
                break;

            case YamletAuthType.Basic:
                var user = _resolver.Resolve(auth.Username, context);
                var pass = _resolver.Resolve(auth.Password, context);
                var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{user}:{pass}"));
                message.Headers.Authorization = new AuthenticationHeaderValue("Basic", encoded);
                break;

            case YamletAuthType.ApiKey:
                var name = _resolver.Resolve(auth.ApiKeyName, context);
                var value = _resolver.Resolve(auth.ApiKeyValue, context);
                if (!string.IsNullOrWhiteSpace(name) && auth.ApiKeyIn == ApiKeyLocation.Header)
                {
                    message.Headers.TryAddWithoutValidation(name, value);
                }
                // Query-located API keys are appended in BuildUrl-equivalent fashion below.
                else if (!string.IsNullOrWhiteSpace(name) && auth.ApiKeyIn == ApiKeyLocation.Query)
                {
                    var uri = message.RequestUri!.ToString();
                    var separator = uri.Contains('?') ? "&" : "?";
                    message.RequestUri = new Uri(
                        uri + separator + Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(value));
                }
                break;

            case YamletAuthType.None:
            default:
                break;
        }
    }

    private void ApplyBody(YamletRequest request, VariableContext context, HttpRequestMessage message)
    {
        var body = request.Body;
        if (body.Type is YamletBodyType.None || string.IsNullOrEmpty(body.Raw))
        {
            return;
        }

        var raw = _resolver.Resolve(body.Raw, context);
        var mediaType = body.Type == YamletBodyType.Json ? "application/json" : "text/plain";
        message.Content = new StringContent(raw, Encoding.UTF8, mediaType);
    }

    private static string DecodeBody(byte[] bytes, HttpContentHeaders headers)
    {
        if (bytes.Length == 0)
        {
            return string.Empty;
        }

        var charset = headers.ContentType?.CharSet;
        try
        {
            var encoding = string.IsNullOrWhiteSpace(charset) ? Encoding.UTF8 : Encoding.GetEncoding(charset);
            return encoding.GetString(bytes);
        }
        catch (ArgumentException)
        {
            return Encoding.UTF8.GetString(bytes);
        }
    }

    private static List<YamletHeader> CollectHeaders(HttpResponseMessage response)
    {
        var result = new List<YamletHeader>();
        foreach (var header in response.Headers)
        {
            result.Add(new YamletHeader { Key = header.Key, Value = string.Join(", ", header.Value), Enabled = true });
        }
        foreach (var header in response.Content.Headers)
        {
            result.Add(new YamletHeader { Key = header.Key, Value = string.Join(", ", header.Value), Enabled = true });
        }
        return result;
    }
}
