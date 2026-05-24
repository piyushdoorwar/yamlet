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
    public const string DefaultUserAgentHeaderName = "User-Agent";
    public const string DefaultUserAgent = "Yamlet/1.0.0";

    private readonly HttpClient _client;
    private readonly VariableResolver _resolver;
    private readonly RequestScriptRunner _scripts;
    private readonly OAuth2TokenService _oauth;

    public RequestExecutor(HttpClient client, VariableResolver resolver, RequestScriptRunner? scripts = null)
    {
        _client = client;
        _resolver = resolver;
        _scripts = scripts ?? new RequestScriptRunner();
        _oauth = new OAuth2TokenService(client);
    }

    /// <summary>The shared token service, exposed so the UI can fetch tokens on demand.</summary>
    public OAuth2TokenService OAuth2 => _oauth;

    /// <summary>Creates an executor backed by a default client with a sensible timeout.</summary>
    public static RequestExecutor CreateDefault() =>
        new(new HttpClient { Timeout = TimeSpan.FromSeconds(100) }, new VariableResolver());

    public async Task<YamletResponse> ExecuteAsync(
        YamletRequest request,
        VariableContext context,
        CancellationToken cancellationToken = default)
        => await ExecuteAsync(request, context, collectionAuth: null, cancellationToken).ConfigureAwait(false);

    public async Task<YamletResponse> ExecuteAsync(
        YamletRequest request,
        VariableContext context,
        YamletAuth? collectionAuth,
        CancellationToken cancellationToken = default)
        => await ExecuteAsync(
            request,
            context,
            collectionAuth,
            RequestScriptVariables.FromContext(context),
            cancellationToken).ConfigureAwait(false);

    public async Task<YamletResponse> ExecuteAsync(
        YamletRequest request,
        VariableContext context,
        YamletAuth? collectionAuth,
        RequestScriptVariables scriptVariables,
        CancellationToken cancellationToken = default,
        string? collectionPreRequestScript = null,
        string? collectionPostResponseScript = null)
    {
        Stopwatch? httpStopwatch = null;
        string consoleText = string.Empty;
        try
        {
            var activeRequest = CloneRequest(request);

            _scripts.RunPreRequest(activeRequest, scriptVariables, collectionPreRequestScript);
            var activeContext = scriptVariables.ToContext();

            var effectiveAuth = EffectiveAuth(activeRequest, collectionAuth);
            var oauthToken = effectiveAuth.Type == YamletAuthType.OAuth2
                ? await ResolveOAuthTokenAsync(effectiveAuth.OAuth2, activeContext, cancellationToken).ConfigureAwait(false)
                : null;

            using var message = BuildMessage(activeRequest, activeContext, collectionAuth, oauthToken);
            consoleText = await BuildConsoleRequestTextAsync(message, cancellationToken).ConfigureAwait(false);
            httpStopwatch = Stopwatch.StartNew();
            using var response = await _client
                .SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);

            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            httpStopwatch.Stop();

            var result = new YamletResponse
            {
                StatusCode = (int)response.StatusCode,
                ReasonPhrase = response.ReasonPhrase ?? string.Empty,
                DurationMs = httpStopwatch.ElapsedMilliseconds,
                SizeBytes = bytes.LongLength,
                ContentType = response.Content.Headers.ContentType?.ToString() ?? string.Empty,
                Body = DecodeBody(bytes, response.Content.Headers),
                Headers = CollectHeaders(response),
            };
            result.ConsoleText = BuildConsoleText(consoleText, result);

            _scripts.RunPostResponse(activeRequest, result, scriptVariables, collectionPostResponseScript);
            await scriptVariables.PersistAsync().ConfigureAwait(false);
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            httpStopwatch?.Stop();
            var result = YamletResponse.FromError("Request was cancelled.", httpStopwatch?.ElapsedMilliseconds ?? 0);
            result.ConsoleText = BuildConsoleText(consoleText, result);
            return result;
        }
        catch (Exception ex)
        {
            httpStopwatch?.Stop();
            var result = YamletResponse.FromError(ex.Message, httpStopwatch?.ElapsedMilliseconds ?? 0);
            result.ConsoleText = BuildConsoleText(consoleText, result);
            return result;
        }
    }

    private static YamletRequest CloneRequest(YamletRequest request) => new()
    {
        Id = request.Id,
        Name = request.Name,
        Method = request.Method,
        Url = request.Url,
        Headers = request.Headers.Select(h => h.Clone()).ToList(),
        QueryParams = request.QueryParams.Select(p => p.Clone()).ToList(),
        PathVariables = request.PathVariables.Select(p => p.Clone()).ToList(),
        Body = request.Body.Clone(),
        Auth = request.Auth.Clone(),
        Variables = request.Variables.Select(v => v.Clone()).ToList(),
        Description = request.Description,
        PreRequestScript = request.PreRequestScript,
        PostResponseScript = request.PostResponseScript,
        SourceFilePath = request.SourceFilePath,
    };

    /// <summary>
    /// Builds the outgoing <see cref="HttpRequestMessage"/> from a request and context.
    /// Exposed internally so tests can assert on the resolved message shape.
    /// </summary>
    internal HttpRequestMessage BuildMessage(
        YamletRequest request,
        VariableContext context,
        YamletAuth? collectionAuth = null,
        string? oauthToken = null)
    {
        var url = BuildUrl(request, context);
        var message = new HttpRequestMessage(new HttpMethod(request.Method.ToUpperInvariant()), url);

        ApplyBody(request, context, message);
        ApplyDefaultHeaders(message);
        ApplyHeaders(request, context, message);
        ApplyAuth(EffectiveAuth(request, collectionAuth), context, message, oauthToken);

        return message;
    }

    /// <summary>
    /// Resolves the OAuth2 token to attach: for client-credentials it fetches (and caches)
    /// from the token endpoint; for other grants it uses the stored access token (set
    /// manually or via the browser auth-code flow). Placeholders are resolved first.
    /// </summary>
    private async Task<string> ResolveOAuthTokenAsync(YamletOAuth2 config, VariableContext context, CancellationToken cancellationToken)
    {
        var resolved = new YamletOAuth2
        {
            GrantType = config.GrantType,
            AccessToken = _resolver.Resolve(config.AccessToken, context),
            AccessTokenUrl = _resolver.Resolve(config.AccessTokenUrl, context),
            ClientId = _resolver.Resolve(config.ClientId, context),
            ClientSecret = _resolver.Resolve(config.ClientSecret, context),
            Scope = _resolver.Resolve(config.Scope, context),
            ClientAuthentication = config.ClientAuthentication,
        };

        if (config.GrantType == OAuth2GrantType.ClientCredentials
            && !string.IsNullOrWhiteSpace(resolved.AccessTokenUrl)
            && !string.IsNullOrWhiteSpace(resolved.ClientId))
        {
            return await _oauth.GetClientCredentialsTokenAsync(resolved, cancellationToken).ConfigureAwait(false);
        }

        return resolved.AccessToken;
    }

    private static YamletAuth EffectiveAuth(YamletRequest request, YamletAuth? collectionAuth) =>
        request.Auth.Type == YamletAuthType.Inherit && collectionAuth is not null
            ? collectionAuth
            : request.Auth;

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

    private static void ApplyDefaultHeaders(HttpRequestMessage message)
    {
        message.Headers.UserAgent.ParseAdd(DefaultUserAgent);
    }

    private void ApplyHeaders(YamletRequest request, VariableContext context, HttpRequestMessage message)
    {
        foreach (var header in request.Headers.Where(h =>
            h.Enabled &&
            !string.IsNullOrWhiteSpace(h.Key) &&
            !IsDefaultHeader(h.Key)))
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

    private static bool IsDefaultHeader(string key) =>
        string.Equals(key, DefaultUserAgentHeaderName, StringComparison.OrdinalIgnoreCase);

    private void ApplyAuth(YamletAuth auth, VariableContext context, HttpRequestMessage message, string? oauthToken = null)
    {
        switch (auth.Type)
        {
            case YamletAuthType.OAuth2:
                var oauth = auth.OAuth2;
                var accessToken = !string.IsNullOrWhiteSpace(oauthToken)
                    ? oauthToken
                    : _resolver.Resolve(oauth.AccessToken, context);
                if (!string.IsNullOrWhiteSpace(accessToken))
                {
                    if (oauth.AddTokenTo == OAuth2TokenLocation.Query)
                    {
                        var uri = message.RequestUri!.ToString();
                        var separator = uri.Contains('?') ? "&" : "?";
                        message.RequestUri = new Uri(uri + separator + "access_token=" + Uri.EscapeDataString(accessToken));
                    }
                    else
                    {
                        var prefix = string.IsNullOrWhiteSpace(oauth.HeaderPrefix)
                            ? "Bearer"
                            : _resolver.Resolve(oauth.HeaderPrefix, context);
                        message.Headers.TryAddWithoutValidation("Authorization", $"{prefix} {accessToken}");
                    }
                }
                break;

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

            case YamletAuthType.Cookie:
                var cookie = _resolver.Resolve(auth.Cookie, context);
                if (!string.IsNullOrWhiteSpace(cookie))
                {
                    message.Headers.TryAddWithoutValidation("Cookie", cookie);
                }
                break;

            case YamletAuthType.None:
            case YamletAuthType.Inherit:
            default:
                break;
        }
    }

    private void ApplyBody(YamletRequest request, VariableContext context, HttpRequestMessage message)
    {
        var body = request.Body;
        if (body.Type is YamletBodyType.None)
        {
            return;
        }

        switch (body.Type)
        {
            case YamletBodyType.Raw:
            case YamletBodyType.Json:
                if (string.IsNullOrEmpty(body.Raw))
                {
                    return;
                }
                var raw = _resolver.Resolve(body.Raw, context);
                var mediaType = body.Type == YamletBodyType.Json ? "application/json" : "text/plain";
                message.Content = new StringContent(raw, Encoding.UTF8, mediaType);
                break;

            case YamletBodyType.UrlEncoded:
                var formPairs = EnabledBodyFields(body, context)
                    .Select(f => new KeyValuePair<string, string>(f.Key, f.Value));
                message.Content = new FormUrlEncodedContent(formPairs);
                break;

            case YamletBodyType.FormData:
                var multipart = new MultipartFormDataContent();
                foreach (var field in EnabledBodyFields(body, context))
                {
                    if (field.IsFile || field.Value.StartsWith('@'))
                    {
                        var filePath = ResolveFilePath(field.Value, request.SourceFilePath);
                        var stream = File.OpenRead(filePath);
                        multipart.Add(new StreamContent(stream), field.Key, Path.GetFileName(filePath));
                    }
                    else
                    {
                        multipart.Add(new StringContent(field.Value, Encoding.UTF8), field.Key);
                    }
                }
                message.Content = multipart;
                break;
        }
    }

    private IEnumerable<YamletBodyField> EnabledBodyFields(YamletRequestBody body, VariableContext context) =>
        body.Fields
            .Where(f => f.Enabled && !string.IsNullOrWhiteSpace(f.Key))
            .Select(f => new YamletBodyField
            {
                Key = _resolver.Resolve(f.Key, context),
                Value = _resolver.Resolve(f.Value, context),
                Description = f.Description,
                Enabled = f.Enabled,
                IsFile = f.IsFile || IsFileDescription(f.Description),
            });

    private static bool IsFileDescription(string description) =>
        string.Equals(description.Trim(), "file", StringComparison.OrdinalIgnoreCase);

    private static string ResolveFilePath(string value, string? sourceFilePath)
    {
        var path = value.StartsWith('@') ? value[1..] : value;
        if (Path.IsPathRooted(path) || string.IsNullOrWhiteSpace(sourceFilePath))
        {
            return path;
        }

        var baseDirectory = Path.GetDirectoryName(sourceFilePath);
        return string.IsNullOrWhiteSpace(baseDirectory) ? path : Path.Combine(baseDirectory, path);
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

    private static async Task<string> BuildConsoleRequestTextAsync(
        HttpRequestMessage message,
        CancellationToken cancellationToken)
    {
        var sb = new StringBuilder();
        sb.Append(message.Method.Method).Append(' ').AppendLine(message.RequestUri?.ToString() ?? string.Empty);
        sb.AppendLine();
        sb.AppendLine("Request Headers");
        AppendHeaders(sb, message.Headers.Select(h => (h.Key, Value: string.Join(", ", h.Value))));

        if (message.Content is not null)
        {
            var contentHeaders = message.Content.Headers
                .Select(h => (h.Key, Value: string.Join(", ", h.Value)))
                .ToList();
            if (contentHeaders.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("Content Headers");
                AppendHeaders(sb, contentHeaders);
            }

            sb.AppendLine();
            sb.AppendLine("Request Body");
            if (message.Content is StreamContent or MultipartContent)
            {
                sb.AppendLine("[stream body omitted]");
            }
            else
            {
                var body = await message.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                sb.AppendLine(string.IsNullOrEmpty(body) ? "[empty]" : body);
            }
        }
        else
        {
            sb.AppendLine();
            sb.AppendLine("Request Body");
            sb.AppendLine("[empty]");
        }

        return sb.ToString().TrimEnd();
    }

    private static string BuildConsoleText(string requestText, YamletResponse response)
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(requestText))
        {
            sb.AppendLine(requestText);
            sb.AppendLine();
        }

        sb.AppendLine("Response");
        if (response.IsError)
        {
            sb.Append("Error: ").AppendLine(response.ErrorMessage ?? "Request failed.");
            return sb.ToString().TrimEnd();
        }

        sb.Append("HTTP ").Append(response.StatusCode).Append(' ').AppendLine(response.ReasonPhrase);
        sb.AppendLine("Response Headers");
        AppendHeaders(sb, response.Headers.Select(h => (h.Key, h.Value)));
        sb.AppendLine();
        sb.AppendLine("Response Body");
        sb.AppendLine(string.IsNullOrEmpty(response.Body) ? "[empty]" : response.Body);
        return sb.ToString().TrimEnd();
    }

    private static void AppendHeaders(StringBuilder sb, IEnumerable<(string Key, string Value)> headers)
    {
        var any = false;
        foreach (var (key, value) in headers)
        {
            any = true;
            sb.Append("  ").Append(key).Append(": ").AppendLine(value);
        }

        if (!any)
        {
            sb.AppendLine("  [none]");
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
