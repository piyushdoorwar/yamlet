using System.Net;
using System.Text;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class CollectionRunnerTests
{
    /// <summary>Routes responses by request URI and records the order requests arrived in.</summary>
    private sealed class RoutingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _route;
        public List<string> Urls { get; } = new();

        public RoutingHandler(Func<HttpRequestMessage, HttpResponseMessage> route) => _route = route;

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Urls.Add(request.RequestUri!.AbsoluteUri);
            return Task.FromResult(_route(request));
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode code, string body = "{}") =>
        new(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static CollectionRunner Runner(Func<HttpRequestMessage, HttpResponseMessage> route, out RoutingHandler handler)
    {
        handler = new RoutingHandler(route);
        var executor = new RequestExecutor(new HttpClient(handler), new VariableResolver());
        return new CollectionRunner(executor);
    }

    private static YamletWorkspace WorkspaceWith(YamletCollection collection)
    {
        var ws = new YamletWorkspace();
        ws.Collections.Add(collection);
        return ws;
    }

    [Fact]
    public async Task Run_PassingTest_Succeeds()
    {
        var runner = Runner(_ => Json(HttpStatusCode.OK), out _);
        var collection = new YamletCollection { Name = "Smoke" };
        collection.Requests.Add(new YamletRequest
        {
            Name = "health",
            Method = "GET",
            Url = "https://api.test/health",
            PostResponseScript = "pm.test('status is 200', () => pm.expect(pm.response.code).to.equal(200));",
        });

        var report = await runner.RunAsync(WorkspaceWith(collection), environment: null);

        Assert.True(report.Success);
        Assert.Equal(1, report.PassedCount);
        var request = Assert.Single(report.Requests);
        Assert.True(Assert.Single(request.Tests).Passed);
    }

    [Fact]
    public async Task Run_NonSuccessStatus_Fails()
    {
        var runner = Runner(_ => Json(HttpStatusCode.InternalServerError), out _);
        var collection = new YamletCollection { Name = "Smoke" };
        collection.Requests.Add(new YamletRequest { Name = "boom", Method = "GET", Url = "https://api.test/boom" });

        var report = await runner.RunAsync(WorkspaceWith(collection), environment: null);

        Assert.False(report.Success);
        Assert.True(Assert.Single(report.Requests).Failed);
    }

    [Fact]
    public async Task Run_FailingAssertionOn200_Fails()
    {
        var runner = Runner(_ => Json(HttpStatusCode.OK, "{\"items\":[]}"), out _);
        var collection = new YamletCollection { Name = "Smoke" };
        collection.Requests.Add(new YamletRequest
        {
            Name = "users",
            Method = "GET",
            Url = "https://api.test/users",
            PostResponseScript = "pm.test('has items', () => pm.expect(pm.response.json().items.length).to.above(0));",
        });

        var report = await runner.RunAsync(WorkspaceWith(collection), environment: null);

        Assert.False(report.Success);
        Assert.Equal(1, report.FailedAssertions);
    }

    [Fact]
    public async Task Run_FlattensFoldersBeforeRootRequests_InOrder()
    {
        var runner = Runner(_ => Json(HttpStatusCode.OK), out var handler);
        var collection = new YamletCollection { Name = "Smoke" };
        var folder = new YamletFolder { Name = "setup" };
        folder.Requests.Add(new YamletRequest { Name = "login", Method = "GET", Url = "https://api.test/login" });
        collection.Folders.Add(folder);
        collection.Requests.Add(new YamletRequest { Name = "root", Method = "GET", Url = "https://api.test/root" });

        await runner.RunAsync(WorkspaceWith(collection), environment: null);

        Assert.Equal(
            new[] { "https://api.test/login", "https://api.test/root" },
            handler.Urls);
    }

    [Fact]
    public async Task Run_Bail_StopsAfterFirstFailure()
    {
        var runner = Runner(
            req => req.RequestUri!.AbsoluteUri.EndsWith("/first")
                ? Json(HttpStatusCode.InternalServerError)
                : Json(HttpStatusCode.OK),
            out var handler);
        var collection = new YamletCollection { Name = "Smoke" };
        collection.Requests.Add(new YamletRequest { Name = "first", Method = "GET", Url = "https://api.test/first" });
        collection.Requests.Add(new YamletRequest { Name = "second", Method = "GET", Url = "https://api.test/second" });

        var report = await runner.RunAsync(
            WorkspaceWith(collection), environment: null, new RunOptions { Bail = true });

        Assert.Single(report.Requests);
        Assert.False(report.Success);
        Assert.Single(handler.Urls); // the second request was never sent
    }

    [Fact]
    public async Task Run_EnvironmentVariableSetByScript_ChainsToNextRequest()
    {
        var runner = Runner(_ => Json(HttpStatusCode.OK, "{\"id\":\"abc\"}"), out var handler);
        var collection = new YamletCollection { Name = "Smoke" };
        collection.Requests.Add(new YamletRequest
        {
            Name = "create",
            Method = "GET",
            Url = "https://api.test/create",
            PostResponseScript = "pm.environment.set('id', pm.response.json().id);",
        });
        collection.Requests.Add(new YamletRequest
        {
            Name = "fetch",
            Method = "GET",
            Url = "https://api.test/items/{{id}}",
        });

        var environment = new YamletEnvironment { Name = "dev" };
        var report = await runner.RunAsync(WorkspaceWith(collection), environment);

        Assert.Equal("https://api.test/items/abc", handler.Urls[1]);
        // The report carries the resolved URL, not the {{id}} template.
        Assert.Equal("https://api.test/items/abc", report.Requests[1].Url);
    }
}
