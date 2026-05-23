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
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastBody { get; private set; }

        public FakeHandler(HttpResponseMessage response) => _response = response;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            if (request.Content is not null)
            {
                LastBody = await request.Content.ReadAsStringAsync(cancellationToken);
            }
            return _response;
        }
    }

    private static (RequestExecutor Executor, FakeHandler Handler) CreateExecutor(HttpResponseMessage response)
    {
        var handler = new FakeHandler(response);
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
}
