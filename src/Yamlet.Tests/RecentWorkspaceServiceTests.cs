using Yamlet.App.Stores;
using Yamlet.App.Models;

namespace Yamlet.Tests;

public class RecentWorkspaceServiceTests : IDisposable
{
    private readonly string _storePath = Path.Combine(
        Path.GetTempPath(),
        "yamlet-cache-" + Guid.NewGuid().ToString("N") + ".json");

    public void Dispose()
    {
        try { File.Delete(_storePath); } catch { /* best effort */ }
    }

    [Fact]
    public void Load_ReadsLegacyRecentWorkspaceArray()
    {
        File.WriteAllText(_storePath, "[\"/tmp/one\",\"/tmp/two\"]");
        var service = new RecentWorkspaceService(_storePath);

        var recent = service.Load();

        Assert.Equal(new[] { "/tmp/one", "/tmp/two" }, recent);
    }

    [Fact]
    public void RememberSelectedEnvironment_RoundTripsByWorkspace()
    {
        var workspace = Path.Combine(Path.GetTempPath(), "yamlet-workspace");
        var service = new RecentWorkspaceService(_storePath);

        service.Add(workspace);
        service.RememberSelectedEnvironment(workspace, "env-dev");

        var reloaded = new RecentWorkspaceService(_storePath);

        Assert.Equal("env-dev", reloaded.LoadSelectedEnvironmentId(workspace));
        Assert.Equal(workspace, Assert.Single(reloaded.Load()));
    }

    [Fact]
    public void SaveSession_RoundTripsOpenTabsAndActiveTab()
    {
        var workspace = Path.Combine(Path.GetTempPath(), "yamlet-workspace");
        var service = new RecentWorkspaceService(_storePath);

        var session = new WorkspaceSession
        {
            ActiveTabIndex = 1,
            OpenTabs =
            {
                new OpenTabRef { Kind = "request", Key = "/ws/collections/api/get.yaml" },
                new OpenTabRef { Kind = "environment", Key = "/ws/environments/dev.yaml" },
            },
        };
        service.SaveSession(workspace, session);

        var reloaded = new RecentWorkspaceService(_storePath).LoadSession(workspace);

        Assert.Equal(1, reloaded.ActiveTabIndex);
        Assert.Equal(2, reloaded.OpenTabs.Count);
        Assert.Equal("request", reloaded.OpenTabs[0].Kind);
        Assert.Equal("/ws/collections/api/get.yaml", reloaded.OpenTabs[0].Key);
        Assert.Equal("environment", reloaded.OpenTabs[1].Kind);
    }

    [Fact]
    public void LoadSession_ReturnsEmptyWhenNoneSaved()
    {
        var service = new RecentWorkspaceService(_storePath);

        var session = service.LoadSession(Path.Combine(Path.GetTempPath(), "never-opened"));

        Assert.Empty(session.OpenTabs);
        Assert.Equal(-1, session.ActiveTabIndex);
    }

    [Fact]
    public void RememberLastResponse_RoundTripsResponseWithoutConsole()
    {
        var workspace = Path.Combine(Path.GetTempPath(), "yamlet-workspace");
        var request = Path.Combine(workspace, "collections", "api", "get.yaml");
        var service = new RecentWorkspaceService(_storePath);

        service.RememberLastResponse(workspace, request, new YamletResponse
        {
            StatusCode = 200,
            ReasonPhrase = "OK",
            DurationMs = 42,
            SizeBytes = 128,
            Body = "{\"ok\":true}",
            ContentType = "application/json",
            ConsoleText = "Authorization: Bearer secret",
            Headers =
            {
                new YamletHeader { Key = "Content-Type", Value = "application/json" },
            },
        });

        var reloaded = new RecentWorkspaceService(_storePath).LoadLastResponse(workspace, request);

        Assert.NotNull(reloaded);
        Assert.Equal(200, reloaded.StatusCode);
        Assert.Equal("OK", reloaded.ReasonPhrase);
        Assert.Equal(42, reloaded.DurationMs);
        Assert.Equal(128, reloaded.SizeBytes);
        Assert.Equal("{\"ok\":true}", reloaded.Body);
        Assert.Equal("application/json", reloaded.ContentType);
        Assert.Equal("Content-Type", Assert.Single(reloaded.Headers).Key);
        Assert.Equal(string.Empty, reloaded.ConsoleText);
    }
}
