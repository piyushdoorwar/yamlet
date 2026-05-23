using Yamlet.App.Stores;

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
}
