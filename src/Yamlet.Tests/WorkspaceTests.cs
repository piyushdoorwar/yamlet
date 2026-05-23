using Yamlet.App.Services;

namespace Yamlet.Tests;

/// <summary>Exercises workspace and collection creation against a real temp directory.</summary>
public class WorkspaceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly WorkspaceService _workspaces;
    private readonly CollectionService _collections;
    private readonly RequestFileService _requestFiles;

    public WorkspaceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "yamlet-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDir);

        var yaml = new YamlSerializationService();
        _requestFiles = new RequestFileService(yaml);
        _collections = new CollectionService(yaml, _requestFiles);
        _workspaces = new WorkspaceService(yaml, _collections);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tempDir, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public async Task CreateWorkspace_CreatesRequiredFolders()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);

        var root = Path.Combine(_tempDir, "yamlet");
        Assert.Equal(root, workspace.RootPath);
        Assert.True(Directory.Exists(Path.Combine(root, "collections")));
        Assert.True(Directory.Exists(Path.Combine(root, "environments")));
        Assert.True(Directory.Exists(Path.Combine(root, "globals")));
        Assert.True(File.Exists(Path.Combine(root, "globals", "globals.yaml")));
    }

    [Fact]
    public async Task CreateWorkspace_SeedsGlobals()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);

        Assert.Contains(workspace.Globals, v => v.Key == "appName" && v.Value == "Yamlet");
    }

    [Fact]
    public async Task OpenWorkspace_DetectsExistingRoot()
    {
        await _workspaces.CreateWorkspaceAsync(_tempDir);

        // Re-open by pointing directly at the yamlet/ root.
        var root = Path.Combine(_tempDir, "yamlet");
        var reopened = await _workspaces.OpenWorkspaceAsync(root);

        Assert.Equal(root, reopened.RootPath);
    }

    [Fact]
    public async Task CreateCollection_WritesMetadataFile()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);

        var collection = await _collections.CreateCollectionAsync(workspace, "My API");

        Assert.True(File.Exists(collection.FilePath));
        Assert.True(Directory.Exists(collection.DirectoryPath));
        Assert.EndsWith(Path.Combine("collections", "my-api"), collection.DirectoryPath!);
    }

    [Fact]
    public async Task CreateRequestAndSave_RoundTripsThroughDisk()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);
        var collection = await _collections.CreateCollectionAsync(workspace, "My API");

        var request = _collections.CreateRequest(collection, parent: null, "Get Users");
        request.Method = "GET";
        request.Url = "https://api.example.com/users";
        await _requestFiles.SaveRequestAsync(request);

        // Reopen the whole workspace and confirm the request loads back.
        var reopened = await _workspaces.OpenWorkspaceAsync(_tempDir);
        var loadedCollection = Assert.Single(reopened.Collections);
        var loadedRequest = Assert.Single(loadedCollection.Requests);

        Assert.Equal("Get Users", loadedRequest.Name);
        Assert.Equal("GET", loadedRequest.Method);
        Assert.Equal("https://api.example.com/users", loadedRequest.Url);
    }

    [Fact]
    public async Task CreateFolderWithRequest_LoadsBackInHierarchy()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);
        var collection = await _collections.CreateCollectionAsync(workspace, "My API");

        var folder = _collections.CreateFolder(collection, parent: null, "users");
        var request = _collections.CreateRequest(collection, folder, "Get User");
        await _requestFiles.SaveRequestAsync(request);

        var reopened = await _workspaces.OpenWorkspaceAsync(_tempDir);
        var loadedCollection = Assert.Single(reopened.Collections);
        var loadedFolder = Assert.Single(loadedCollection.Folders);

        Assert.Equal("users", loadedFolder.Name);
        Assert.Single(loadedFolder.Requests);
        Assert.Equal("Get User", loadedFolder.Requests[0].Name);
    }
}
