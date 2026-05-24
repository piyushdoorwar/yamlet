using System.Net;
using System.Text;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class RequestExecutorTests
{
    /// <summary>A fake handler that records the request it received and returns a canned response.</summary>
    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly HttpResponseMessage _response;
        private readonly TimeSpan _delay;
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastBody { get; private set; }

        public FakeHandler(HttpResponseMessage response, TimeSpan delay = default)
        {
            _response = response;
            _delay = delay;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            if (request.Content is not null)
            {
                LastBody = await request.Content.ReadAsStringAsync(cancellationToken);
            }
            if (_delay > TimeSpan.Zero)
            {
                await Task.Delay(_delay, cancellationToken);
            }
            return _response;
        }
    }

    private static (RequestExecutor Executor, FakeHandler Handler) CreateExecutor(
        HttpResponseMessage response,
        TimeSpan delay = default)
    {
        var handler = new FakeHandler(response, delay);
        return (new RequestExecutor(new HttpClient(handler), new VariableResolver()), handler);
    }

    [Fact]
    public async Task Execute_ReturnsStatusBodyAndSize()
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
        };
        var (executor, _) = CreateExecutor(response);

        var request = new YamletRequest { Method = "GET", Url = "https://example.com/api" };
        var result = await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.False(result.IsError);
        Assert.Equal(200, result.StatusCode);
        Assert.Equal("{\"ok\":true}", result.Body);
        Assert.Equal(Encoding.UTF8.GetByteCount("{\"ok\":true}"), result.SizeBytes);
        Assert.Contains("application/json", result.ContentType);
    }

    [Fact]
    public async Task Execute_ResolvesVariablesInUrlAndAppendsQueryParams()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "{{baseUrl}}/users",
            QueryParams = { new YamletQueryParam { Key = "page", Value = "{{page}}", Enabled = true } },
        };
        var context = VariableContext.Create(
            null, null,
            new List<YamletVariable>
            {
                new() { Key = "baseUrl", Value = "https://api.test", Enabled = true },
                new() { Key = "page", Value = "2", Enabled = true },
            },
            null);

        await executor.ExecuteAsync(request, context);

        Assert.Equal("https://api.test/users?page=2", handler.LastRequest!.RequestUri!.ToString());
    }

    [Fact]
    public async Task Execute_AppliesBearerAuthHeader()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Auth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "{{token}}" },
        };
        var context = VariableContext.Create(
            null, null, new List<YamletVariable> { new() { Key = "token", Value = "abc123", Enabled = true } }, null);

        await executor.ExecuteAsync(request, context);

        Assert.Equal("Bearer", handler.LastRequest!.Headers.Authorization!.Scheme);
        Assert.Equal("abc123", handler.LastRequest.Headers.Authorization.Parameter);
    }

    [Fact]
    public async Task Execute_AppliesCollectionBearerWhenRequestInheritsAuth()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Auth = new YamletAuth { Type = YamletAuthType.Inherit },
        };
        var collectionAuth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "{{token}}" };
        var context = VariableContext.Create(
            null, null, new List<YamletVariable> { new() { Key = "token", Value = "abc123", Enabled = true } }, null);

        await executor.ExecuteAsync(request, context, collectionAuth);

        Assert.Equal("Bearer", handler.LastRequest!.Headers.Authorization!.Scheme);
        Assert.Equal("abc123", handler.LastRequest.Headers.Authorization.Parameter);
    }

    [Fact]
    public async Task Execute_RequestAuthOverridesCollectionAuth()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Auth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "request-token" },
        };
        var collectionAuth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "collection-token" };

        await executor.ExecuteAsync(request, VariableContext.Empty, collectionAuth);

        Assert.Equal("request-token", handler.LastRequest!.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task Execute_NoAuthRequestDoesNotUseCollectionAuth()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Auth = new YamletAuth { Type = YamletAuthType.None },
        };
        var collectionAuth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "collection-token" };

        await executor.ExecuteAsync(request, VariableContext.Empty, collectionAuth);

        Assert.Null(handler.LastRequest!.Headers.Authorization);
    }

    [Fact]
    public async Task Execute_AppliesCookieAuthHeader()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Auth = new YamletAuth { Type = YamletAuthType.Cookie, Cookie = "session={{sessionId}}" },
        };
        var context = VariableContext.Create(
            null, null, new List<YamletVariable> { new() { Key = "sessionId", Value = "abc123", Enabled = true } }, null);

        await executor.ExecuteAsync(request, context);

        Assert.True(handler.LastRequest!.Headers.TryGetValues("Cookie", out var values));
        Assert.Equal("session=abc123", Assert.Single(values));
    }

    [Fact]
    public async Task Execute_SendsJsonBody()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.Created));

        var request = new YamletRequest
        {
            Method = "POST",
            Url = "https://api.test",
            Body = new YamletRequestBody { Type = YamletBodyType.Json, Raw = "{\"name\":\"{{who}}\"}" },
        };
        var context = VariableContext.Create(
            null, null, new List<YamletVariable> { new() { Key = "who", Value = "yamlet", Enabled = true } }, null);

        var result = await executor.ExecuteAsync(request, context);

        Assert.Equal(201, result.StatusCode);
        Assert.Equal("{\"name\":\"yamlet\"}", handler.LastBody);
        Assert.Equal("application/json", handler.LastRequest!.Content!.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task Execute_ReturnsConsoleSnapshotWithResolvedRequestAndResponse()
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json"),
        };
        var (executor, _) = CreateExecutor(response);

        var request = new YamletRequest
        {
            Method = "POST",
            Url = "{{baseUrl}}/users",
            Headers = { new YamletHeader { Key = "X-Trace", Value = "{{traceId}}", Enabled = true } },
            Body = new YamletRequestBody { Type = YamletBodyType.Json, Raw = "{\"name\":\"{{name}}\"}" },
        };
        var context = VariableContext.Create(null, null, new List<YamletVariable>
        {
            new() { Key = "baseUrl", Value = "https://api.test", Enabled = true },
            new() { Key = "traceId", Value = "abc", Enabled = true },
            new() { Key = "name", Value = "Yamlet", Enabled = true },
        }, null);

        var result = await executor.ExecuteAsync(request, context);

        Assert.Contains("POST https://api.test/users", result.ConsoleText);
        Assert.Contains("X-Trace: abc", result.ConsoleText);
        Assert.Contains("{\"name\":\"Yamlet\"}", result.ConsoleText);
        Assert.Contains("HTTP 200 OK", result.ConsoleText);
        Assert.Contains("{\"ok\":true}", result.ConsoleText);
    }

    [Fact]
    public async Task Execute_SendsUrlEncodedBody()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "POST",
            Url = "https://api.test",
            Body = new YamletRequestBody
            {
                Type = YamletBodyType.UrlEncoded,
                Fields =
                {
                    new() { Key = "name", Value = "{{who}}", Enabled = true },
                    new() { Key = "skip", Value = "no", Enabled = false },
                },
            },
        };
        var context = VariableContext.Create(
            null, null, new List<YamletVariable> { new() { Key = "who", Value = "yamlet user", Enabled = true } }, null);

        await executor.ExecuteAsync(request, context);

        Assert.Equal("application/x-www-form-urlencoded", handler.LastRequest!.Content!.Headers.ContentType!.MediaType);
        Assert.Equal("name=yamlet+user", handler.LastBody);
    }

    [Fact]
    public async Task Execute_SendsMultipartFormDataWithTextField()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "POST",
            Url = "https://api.test",
            Body = new YamletRequestBody
            {
                Type = YamletBodyType.FormData,
                Fields =
                {
                    new() { Key = "domain", Value = "{{domain}}", Enabled = true },
                },
            },
        };
        var context = VariableContext.Create(
            null, null, new List<YamletVariable> { new() { Key = "domain", Value = "ccs", Enabled = true } }, null);

        await executor.ExecuteAsync(request, context);

        Assert.StartsWith("multipart/form-data", handler.LastRequest!.Content!.Headers.ContentType!.MediaType);
        Assert.Contains("name=domain", handler.LastBody);
        Assert.Contains("ccs", handler.LastBody);
    }

    [Fact]
    public async Task Execute_DisabledHeaderIsNotSent()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Headers =
            {
                new YamletHeader { Key = "X-On", Value = "1", Enabled = true },
                new YamletHeader { Key = "X-Off", Value = "2", Enabled = false },
            },
        };

        await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.True(handler.LastRequest!.Headers.Contains("X-On"));
        Assert.False(handler.LastRequest.Headers.Contains("X-Off"));
    }

    [Fact]
    public async Task Execute_SendsDefaultUserAgentHeader()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
        };

        await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.Equal("Yamlet/1.0.0", handler.LastRequest!.Headers.UserAgent.ToString());
    }

    [Fact]
    public async Task Execute_DefaultUserAgentCannotBeOverriddenByRequestHeader()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            Headers =
            {
                new YamletHeader { Key = "User-Agent", Value = "Other/2.0", Enabled = true },
            },
        };

        await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.Equal("Yamlet/1.0.0", handler.LastRequest!.Headers.UserAgent.ToString());
    }

    [Fact]
    public async Task Execute_RunsPreRequestScriptBeforeSending()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "{{baseUrl}}/users",
            PreRequestScript = """
pm.variables.set('baseUrl', 'https://script.test');
pm.request.headers.add({ key: 'X-Script', value: pm.variables.get('baseUrl') });
""",
        };

        await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.Equal("https://script.test/users", handler.LastRequest!.RequestUri!.ToString());
        Assert.True(handler.LastRequest.Headers.TryGetValues("X-Script", out var values));
        Assert.Equal("https://script.test", Assert.Single(values));
    }

    [Fact]
    public async Task Execute_ScriptsCanUseConsole()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            PreRequestScript = """
console.log('before request');
console.warn('still fine');
pm.request.headers.add({ key: 'X-Console', value: 'ok' });
""",
        };

        var result = await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.False(result.IsError);
        Assert.True(handler.LastRequest!.Headers.TryGetValues("X-Console", out var values));
        Assert.Equal("ok", Assert.Single(values));
    }

    [Fact]
    public async Task Execute_DurationExcludesPreRequestScript()
    {
        var (executor, _) = CreateExecutor(
            new HttpResponseMessage(HttpStatusCode.OK),
            TimeSpan.FromMilliseconds(40));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            PreRequestScript = """
const started = Date.now();
while (Date.now() - started < 150) {
}
""",
        };

        var result = await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.False(result.IsError);
        Assert.InRange(result.DurationMs, 30, 140);
    }

    [Fact]
    public async Task Execute_EnvironmentSetMutatesEnvironmentVariables()
    {
        var (executor, _) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"id\":\"env-123\"}", Encoding.UTF8, "application/json"),
        });
        var environment = new List<YamletVariable>();
        var persisted = false;

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            PostResponseScript = "pm.environment.set('createdId', pm.response.json().id);",
        };
        var context = VariableContext.Create(null, environment, null, request.Variables);
        var scriptVariables = new RequestScriptVariables(
            context,
            environment: environment,
            request: request.Variables,
            persistAsync: scopes =>
            {
                persisted = scopes.Contains(RequestScriptVariableScope.Environment);
                return Task.CompletedTask;
            });

        var result = await executor.ExecuteAsync(
            request,
            context,
            collectionAuth: null,
            scriptVariables,
            CancellationToken.None);

        Assert.False(result.IsError);
        var variable = Assert.Single(environment);
        Assert.Equal("createdId", variable.Key);
        Assert.Equal("env-123", variable.Value);
        Assert.True(persisted);
    }

    [Fact]
    public async Task Execute_RunsPostResponseScriptAfterResponse()
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{\"id\":5}", Encoding.UTF8, "application/json"),
        };
        var (executor, _) = CreateExecutor(response);

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            PostResponseScript = """
pm.test('status', () => pm.expect(pm.response.code).to.equal(200));
const body = pm.response.json();
if (body.id !== 5) {
  throw new Error('Unexpected response body');
}
""",
        };

        var result = await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.False(result.IsError);
        Assert.Equal(200, result.StatusCode);
    }

    [Fact]
    public async Task Execute_ScriptFailureReturnsErrorAndSkipsSend()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test",
            PreRequestScript = "throw new Error('pre failed');",
        };

        var result = await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.True(result.IsError);
        Assert.Contains("pre failed", result.ErrorMessage);
        Assert.Null(handler.LastRequest);
    }

    [Fact]
    public async Task Execute_ReturnsErrorResponseOnTransportFailure()
    {
        var executor = new RequestExecutor(
            new HttpClient(new ThrowingHandler()), new VariableResolver());

        var request = new YamletRequest { Method = "GET", Url = "https://unreachable.invalid" };
        var result = await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.True(result.IsError);
        Assert.NotNull(result.ErrorMessage);
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
            => throw new HttpRequestException("boom");
    }

    /// <summary>A fake handler that routes by request URI and records every request.</summary>
    private sealed class RoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _route;
        public List<HttpRequestMessage> Requests { get; } = new();

        public RoutingHandler(Func<HttpRequestMessage, HttpResponseMessage> route) => _route = route;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(_route(request));
        }
    }

    [Fact]
    public async Task Execute_OAuth2ClientCredentials_FetchesTokenAndAttachesBearer()
    {
        var handler = new RoutingHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/oauth2/token")
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"access_token\":\"tok-123\",\"token_type\":\"Bearer\",\"expires_in\":3600}",
                        Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.OK));
        var executor = new RequestExecutor(new HttpClient(handler), new VariableResolver());

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test/courses",
            Auth = new YamletAuth { Type = YamletAuthType.Inherit },
        };
        var collectionAuth = new YamletAuth
        {
            Type = YamletAuthType.OAuth2,
            OAuth2 = new YamletOAuth2
            {
                GrantType = OAuth2GrantType.ClientCredentials,
                AccessTokenUrl = "https://issuer.test/oauth2/token",
                ClientId = "{{cid}}",
                ClientSecret = "{{secret}}",
                Scope = "ccs-api/read",
                ClientAuthentication = OAuth2ClientAuthentication.BasicHeader,
                AddTokenTo = OAuth2TokenLocation.Header,
            },
        };
        var context = VariableContext.Create(null, null, new List<YamletVariable>
        {
            new() { Key = "cid", Value = "client-1", Enabled = true },
            new() { Key = "secret", Value = "shh", Enabled = true },
        }, null);

        await executor.ExecuteAsync(request, context, collectionAuth);

        var tokenReq = handler.Requests.First(r => r.RequestUri!.AbsoluteUri.Contains("/oauth2/token"));
        Assert.Equal(HttpMethod.Post, tokenReq.Method);
        Assert.Equal("Basic", tokenReq.Headers.Authorization!.Scheme);
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes("client-1:shh")),
            tokenReq.Headers.Authorization.Parameter);

        var apiReq = handler.Requests.First(r => r.RequestUri!.AbsoluteUri.Contains("api.test"));
        Assert.Equal("Bearer tok-123", apiReq.Headers.GetValues("Authorization").Single());
    }

    [Fact]
    public async Task Execute_OAuth2_AttachesStoredTokenAsQueryParam()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest
        {
            Method = "GET",
            Url = "https://api.test/data",
            Auth = new YamletAuth
            {
                Type = YamletAuthType.OAuth2,
                OAuth2 = new YamletOAuth2
                {
                    GrantType = OAuth2GrantType.AuthorizationCode,
                    AccessToken = "stored-xyz",
                    AddTokenTo = OAuth2TokenLocation.Query,
                },
            },
        };

        await executor.ExecuteAsync(request, VariableContext.Empty);

        Assert.Contains("access_token=stored-xyz", handler.LastRequest!.RequestUri!.ToString());
    }

    [Fact]
    public async Task Execute_RunsCollectionScriptsAroundRequest()
    {
        var (executor, handler) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest { Method = "GET", Url = "https://api.test" };
        var context = VariableContext.Empty;
        var scriptVariables = RequestScriptVariables.FromContext(context);

        var result = await executor.ExecuteAsync(
            request, context, collectionAuth: null, scriptVariables, CancellationToken.None,
            collectionPreRequestScript: "pm.request.headers.add({ key: 'X-Collection', value: 'yes' });",
            collectionPostResponseScript: "pm.test('ok', () => pm.expect(pm.response.code).to.be.within(200, 299));");

        // Collection pre-request script applied a header...
        Assert.True(handler.LastRequest!.Headers.TryGetValues("X-Collection", out var values));
        Assert.Equal("yes", Assert.Single(values));
        // ...and the collection post-response test ran without turning the send into an error.
        Assert.False(result.IsError);
    }

    [Fact]
    public async Task Execute_CollectionTestFailureDoesNotFailTheSend()
    {
        var (executor, _) = CreateExecutor(new HttpResponseMessage(HttpStatusCode.OK));

        var request = new YamletRequest { Method = "GET", Url = "https://api.test" };
        var context = VariableContext.Empty;
        var scriptVariables = RequestScriptVariables.FromContext(context);

        var result = await executor.ExecuteAsync(
            request, context, collectionAuth: null, scriptVariables, CancellationToken.None,
            collectionPostResponseScript: "pm.test('always fails', () => pm.expect(1).to.equal(2));");

        Assert.False(result.IsError);
        Assert.Equal(200, result.StatusCode);
    }
}
