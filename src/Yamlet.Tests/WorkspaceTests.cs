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

    [Fact]
    public async Task SaveCollection_WritesMetadataOnly_NotEmbeddedRequests()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);
        var collection = await _collections.CreateCollectionAsync(workspace, "My API");
        var request = _collections.CreateRequest(collection, parent: null, "Get Users");
        await _requestFiles.SaveRequestAsync(request);
        await _collections.SaveCollectionAsync(collection);

        var yaml = await File.ReadAllTextAsync(collection.FilePath!);

        // Native Yamlet metadata, not the Postman v2.1 shape with embedded requests.
        Assert.Contains("name: My API", yaml);
        Assert.DoesNotContain("item:", yaml);
        Assert.DoesNotContain("info:", yaml);
        Assert.DoesNotContain("Get Users", yaml);
    }

    [Fact]
    public async Task RequestOrder_PersistsAcrossReopen()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);
        var collection = await _collections.CreateCollectionAsync(workspace, "My API");

        var a = _collections.CreateRequest(collection, parent: null, "Alpha");
        var b = _collections.CreateRequest(collection, parent: null, "Bravo");
        var c = _collections.CreateRequest(collection, parent: null, "Charlie");
        foreach (var r in new[] { a, b, c })
        {
            await _requestFiles.SaveRequestAsync(r);
        }

        // Reorder in memory (Charlie, Alpha, Bravo) and persist the new positions.
        collection.Requests.Clear();
        collection.Requests.AddRange(new[] { c, a, b });
        await _collections.SaveContainerOrderAsync(collection, folder: null);

        var reopened = await _workspaces.OpenWorkspaceAsync(_tempDir);
        var loaded = Assert.Single(reopened.Collections);

        Assert.Equal(new[] { "Charlie", "Alpha", "Bravo" }, loaded.Requests.Select(r => r.Name));
    }

    [Fact]
    public async Task FolderOrder_PersistsAcrossReopen()
    {
        var workspace = await _workspaces.CreateWorkspaceAsync(_tempDir);
        var collection = await _collections.CreateCollectionAsync(workspace, "My API");

        var x = _collections.CreateFolder(collection, parent: null, "Xray");
        var y = _collections.CreateFolder(collection, parent: null, "Yankee");
        var z = _collections.CreateFolder(collection, parent: null, "Zulu");

        // Reorder in memory (Zulu, Xray, Yankee) and persist via folder.yaml.
        collection.Folders.Clear();
        collection.Folders.AddRange(new[] { z, x, y });
        await _collections.SaveContainerOrderAsync(collection, folder: null);

        Assert.True(File.Exists(Path.Combine(z.DirectoryPath!, CollectionService.FolderMetadataFileName)));

        var reopened = await _workspaces.OpenWorkspaceAsync(_tempDir);
        var loaded = Assert.Single(reopened.Collections);

        Assert.Equal(new[] { "Zulu", "Xray", "Yankee" }, loaded.Folders.Select(f => f.Name));
    }
}
