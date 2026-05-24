using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// Runs the OAuth 2.0 authorization-code grant (with PKCE) interactively: opens the
/// system browser to the provider's authorize URL, captures the redirect on a local
/// loopback listener, then exchanges the code for tokens via
/// <see cref="OAuth2TokenService"/>. All config fields are expected to be already
/// variable-resolved.
/// </summary>
public sealed class OAuth2BrowserFlow
{
    private const string DefaultRedirect = "http://127.0.0.1:7878/callback";

    private readonly OAuth2TokenService _tokens;

    public OAuth2BrowserFlow(OAuth2TokenService tokens) => _tokens = tokens;

    public async Task<OAuth2TokenService.TokenResult> AuthorizeAsync(YamletOAuth2 config, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(config.AuthUrl))
        {
            throw new InvalidOperationException("An authorization URL is required for the authorization-code grant.");
        }

        var redirectUri = NormalizeRedirect(config.RedirectUri, out var listenerPrefix);
        config.RedirectUri = redirectUri; // the token exchange must echo the same value

        var (verifier, challenge) = CreatePkce(config.ChallengeAlgorithm);
        var state = RandomToken(24);
        var authorizeUrl = BuildAuthorizeUrl(config, redirectUri, state, challenge);

        using var listener = new HttpListener();
        listener.Prefixes.Add(listenerPrefix);
        listener.Start();
        await using var cancelRegistration = cancellationToken.Register(() =>
        {
            try { listener.Stop(); } catch { /* ignore */ }
        });

        try
        {
            OpenBrowser(authorizeUrl);
            var code = await WaitForCodeAsync(listener, state, cancellationToken).ConfigureAwait(false);
            return await _tokens
                .ExchangeAuthorizationCodeAsync(config, code, config.ChallengeAlgorithm == "plain" ? verifier : verifier, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            if (listener.IsListening)
            {
                listener.Stop();
            }
        }
    }

    /// <summary>
    /// Uses the configured redirect when it's a loopback http URL; otherwise falls back to
    /// a local default. Returns the redirect to send and the listener prefix to bind.
    /// </summary>
    private static string NormalizeRedirect(string configured, out string listenerPrefix)
    {
        var redirect = configured;
        if (string.IsNullOrWhiteSpace(redirect)
            || !Uri.TryCreate(redirect, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttp
            || !(uri.IsLoopback))
        {
            redirect = DefaultRedirect;
            uri = new Uri(redirect);
        }

        listenerPrefix = $"{uri.Scheme}://{uri.Host}:{uri.Port}/";
        return redirect;
    }

    private static string BuildAuthorizeUrl(YamletOAuth2 config, string redirectUri, string state, string challenge)
    {
        var query = new List<string>
        {
            "response_type=code",
            "client_id=" + Uri.EscapeDataString(config.ClientId),
            "redirect_uri=" + Uri.EscapeDataString(redirectUri),
            "state=" + Uri.EscapeDataString(state),
        };
        if (!string.IsNullOrWhiteSpace(config.Scope))
        {
            query.Add("scope=" + Uri.EscapeDataString(config.Scope));
        }
        if (!string.IsNullOrWhiteSpace(challenge))
        {
            query.Add("code_challenge=" + Uri.EscapeDataString(challenge));
            query.Add("code_challenge_method=" + (config.ChallengeAlgorithm == "plain" ? "plain" : "S256"));
        }

        var separator = config.AuthUrl.Contains('?') ? "&" : "?";
        return config.AuthUrl + separator + string.Join("&", query);
    }

    private static async Task<string> WaitForCodeAsync(HttpListener listener, string expectedState, CancellationToken cancellationToken)
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var context = await listener.GetContextAsync().ConfigureAwait(false);
            var query = context.Request.QueryString;
            var code = query["code"];
            var error = query["error"];
            var state = query["state"];

            var ok = !string.IsNullOrEmpty(code) && string.Equals(state, expectedState, StringComparison.Ordinal);
            await RespondAsync(context, ok, error).ConfigureAwait(false);

            if (!string.IsNullOrEmpty(error))
            {
                throw new InvalidOperationException($"Authorization failed: {error}");
            }
            if (!string.IsNullOrEmpty(code))
            {
                if (!string.Equals(state, expectedState, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Authorization state mismatch (possible CSRF).");
                }
                return code!;
            }
            // Ignore unrelated requests (e.g. favicon) and keep waiting.
        }
    }

    private static async Task RespondAsync(HttpListenerContext context, bool ok, string? error)
    {
        var message = ok
            ? "Authorization complete. You can close this tab and return to Yamlet."
            : $"Authorization failed{(string.IsNullOrEmpty(error) ? "." : $": {error}.")}";
        var html = $"<!doctype html><html><body style=\"font-family:sans-serif;padding:2rem\"><h3>Yamlet</h3><p>{message}</p></body></html>";
        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        context.Response.Close();
    }

    private static (string Verifier, string Challenge) CreatePkce(string algorithm)
    {
        var verifier = RandomToken(64);
        if (string.Equals(algorithm, "plain", StringComparison.OrdinalIgnoreCase))
        {
            return (verifier, verifier);
        }

        var hash = SHA256.HashData(Encoding.ASCII.GetBytes(verifier));
        return (verifier, Base64Url(hash));
    }

    private static string RandomToken(int bytes)
    {
        var buffer = RandomNumberGenerator.GetBytes(bytes);
        return Base64Url(buffer);
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // Fall back to the platform opener if shell-execute isn't available.
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                Process.Start("xdg-open", url);
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                Process.Start("open", url);
            }
            else
            {
                Process.Start(new ProcessStartInfo("cmd", $"/c start \"\" \"{url}\"") { CreateNoWindow = true });
            }
        }
    }
}
