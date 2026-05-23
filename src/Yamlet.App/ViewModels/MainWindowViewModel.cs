using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Models;
using Yamlet.App.Services;
using Yamlet.App.Stores;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Root view model for the main window. Owns the workspace, the collection tree, the
/// active request editor and the top-level commands.
/// </summary>
public sealed partial class MainWindowViewModel : ViewModelBase
{
    private readonly WorkspaceService _workspaceService;
    private readonly CollectionService _collectionService;
    private readonly RequestFileService _requestFileService;
    private readonly RequestExecutor _executor;
    private readonly IDialogService _dialogs;
    private readonly RecentWorkspaceService _recent;

    public MainWindowViewModel(
        WorkspaceService workspaceService,
        CollectionService collectionService,
        RequestFileService requestFileService,
        RequestExecutor executor,
        IDialogService dialogs,
        RecentWorkspaceService recent)
    {
        _workspaceService = workspaceService;
        _collectionService = collectionService;
        _requestFileService = requestFileService;
        _executor = executor;
        _dialogs = dialogs;
        _recent = recent;
    }

    /// <summary>Parameterless constructor for the XAML design-time previewer.</summary>
    public MainWindowViewModel()
        : this(
            new WorkspaceService(new YamlSerializationService(), new CollectionService(new YamlSerializationService(), new RequestFileService(new YamlSerializationService()))),
            new CollectionService(new YamlSerializationService(), new RequestFileService(new YamlSerializationService())),
            new RequestFileService(new YamlSerializationService()),
            RequestExecutor.CreateDefault(),
            new DesignDialogService(),
            new RecentWorkspaceService())
    {
    }

    public ObservableCollection<TreeNodeViewModel> CollectionNodes { get; } = new();

    public ObservableCollection<YamletEnvironment> Environments { get; } = new();

    [ObservableProperty]
    private YamletEnvironment? _selectedEnvironment;

    [ObservableProperty]
    private YamletWorkspace? _workspace;

    [ObservableProperty]
    private TreeNodeViewModel? _selectedNode;

    [ObservableProperty]
    private RequestEditorViewModel? _currentEditor;

    /// <summary>
    /// What the main panel shows: a request editor when a request is selected, or an
    /// environment variable editor when an environment is opened.
    /// </summary>
    [ObservableProperty]
    private object? _mainContent;

    // Collapsible sidebar sections (accordion).
    [ObservableProperty]
    private bool _collectionsExpanded = true;

    [ObservableProperty]
    private bool _environmentsExpanded = true;

    [RelayCommand]
    private void ToggleCollections() => CollectionsExpanded = !CollectionsExpanded;

    [RelayCommand]
    private void ToggleEnvironments() => EnvironmentsExpanded = !EnvironmentsExpanded;

    /// <summary>
    /// Opens an environment in the main panel for viewing/editing. Selecting an
    /// environment also makes it the active one used to resolve {{variables}}.
    /// </summary>
    partial void OnSelectedEnvironmentChanged(YamletEnvironment? value)
    {
        if (value is null)
        {
            return;
        }

        MainContent = new VariableSetEditorViewModel(
            value.Name,
            "Environment variables. Use these names inside {{placeholders}}.",
            value.Variables,
            () => _workspaceService.SaveEnvironmentAsync(value),
            msg => StatusMessage = msg);
    }

    [ObservableProperty]
    private string _statusMessage = "Open or create a Yamlet workspace to begin.";

    [ObservableProperty]
    private bool _isBusy;

    public bool HasWorkspace => Workspace is not null;

    public string WorkspaceTitle => Workspace is null
        ? "No workspace"
        : $"{Workspace.Name}  ·  {Workspace.RootPath}";

    partial void OnWorkspaceChanged(YamletWorkspace? value)
    {
        OnPropertyChanged(nameof(HasWorkspace));
        OnPropertyChanged(nameof(WorkspaceTitle));
    }

    partial void OnSelectedNodeChanged(TreeNodeViewModel? value)
    {
        if (value is RequestNodeViewModel requestNode)
        {
            CurrentEditor = new RequestEditorViewModel(
                requestNode,
                _executor,
                _requestFileService,
                request => BuildContext(requestNode.OwningCollection, request),
                msg => StatusMessage = msg);
            MainContent = CurrentEditor;
        }
    }

    private VariableContext BuildContext(YamletCollection collection, YamletRequest request) =>
        VariableContext.Create(
            globals: Workspace?.Globals,
            environment: SelectedEnvironment?.Variables,
            collection: collection.Variables,
            request: request.Variables);

    // ---- Startup -----------------------------------------------------------

    /// <summary>
    /// Reopens the most recently used workspace, if one is remembered and still exists.
    /// Called once when the main window opens.
    /// </summary>
    public async Task InitializeAsync()
    {
        var lastPath = _recent.Load().FirstOrDefault(Directory.Exists);
        if (lastPath is null)
        {
            return;
        }

        await RunBusyAsync("Restoring last workspace…", async () =>
        {
            var workspace = await _workspaceService.OpenWorkspaceAsync(lastPath);
            LoadWorkspace(workspace);
            StatusMessage = $"Reopened {workspace.Name} ({workspace.Collections.Count} collection(s))";
        });
    }

    // ---- Workspace commands ------------------------------------------------

    [RelayCommand]
    private async Task NewWorkspaceAsync()
    {
        var path = await _dialogs.PickFolderAsync("Choose a folder for the new Yamlet workspace");
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        await RunBusyAsync("Creating workspace…", async () =>
        {
            var workspace = await _workspaceService.CreateWorkspaceAsync(path);
            LoadWorkspace(workspace);
            _recent.Add(path);
            StatusMessage = $"Created workspace at {workspace.RootPath}";
        });
    }

    [RelayCommand]
    private async Task OpenWorkspaceAsync()
    {
        var path = await _dialogs.PickFolderAsync("Open a Yamlet workspace folder");
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        await RunBusyAsync("Opening workspace…", async () =>
        {
            var workspace = await _workspaceService.OpenWorkspaceAsync(path);
            LoadWorkspace(workspace);
            _recent.Add(path);
            StatusMessage = $"Opened {workspace.Name} ({workspace.Collections.Count} collection(s))";
        });
    }

    // ---- Tree commands -----------------------------------------------------

    [RelayCommand(CanExecute = nameof(HasWorkspace))]
    private async Task NewCollectionAsync()
    {
        if (Workspace is null)
        {
            return;
        }

        var name = await _dialogs.PromptTextAsync("New Collection", "Collection name", "New Collection");
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var collection = await _collectionService.CreateCollectionAsync(Workspace, name);
        Workspace.Collections.Add(collection);

        var node = BuildCollectionNode(collection);
        CollectionNodes.Add(node);
        SelectedNode = node;
        StatusMessage = $"Created collection '{collection.Name}'";
    }

    [RelayCommand]
    private async Task NewFolderAsync()
    {
        if (!TryResolveTarget(out var collection, out var parentFolder, allowRequestParent: true))
        {
            StatusMessage = "Select a collection or folder first.";
            return;
        }

        var name = await _dialogs.PromptTextAsync("New Folder", "Folder name", "New Folder");
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var folder = _collectionService.CreateFolder(collection!, parentFolder, name);
        var parentNode = FindNodeForFolderParent(collection!, parentFolder);
        var node = new FolderNodeViewModel
        {
            Folder = folder,
            OwningCollection = collection!,
            Name = folder.Name,
            Parent = parentNode,
        };
        (parentNode?.Children ?? CollectionNodes).Add(node);
        if (parentNode is not null)
        {
            parentNode.IsExpanded = true;
        }
        SelectedNode = node;
        StatusMessage = $"Created folder '{folder.Name}'";
    }

    [RelayCommand]
    private async Task NewRequestAsync()
    {
        if (!TryResolveTarget(out var collection, out var parentFolder, allowRequestParent: true))
        {
            StatusMessage = "Select a collection or folder first.";
            return;
        }

        var name = await _dialogs.PromptTextAsync("New Request", "Request name", "New Request");
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var request = _collectionService.CreateRequest(collection!, parentFolder, name);
        await _requestFileService.SaveRequestAsync(request);

        var parentNode = FindNodeForFolderParent(collection!, parentFolder);
        var node = new RequestNodeViewModel
        {
            Request = request,
            OwningCollection = collection!,
            ParentFolder = parentFolder,
            Name = request.Name,
            Method = request.Method,
            Parent = parentNode,
        };
        (parentNode?.Children ?? CollectionNodes).Add(node);
        if (parentNode is not null)
        {
            parentNode.IsExpanded = true;
        }
        SelectedNode = node;
        StatusMessage = $"Created request '{request.Name}'";
    }

    // ---- Helpers -----------------------------------------------------------

    private void LoadWorkspace(YamletWorkspace workspace)
    {
        Workspace = workspace;
        CurrentEditor = null;
        SelectedNode = null;

        CollectionNodes.Clear();
        foreach (var collection in workspace.Collections)
        {
            CollectionNodes.Add(BuildCollectionNode(collection));
        }

        Environments.Clear();
        foreach (var env in workspace.Environments)
        {
            Environments.Add(env);
        }

        // Make the first environment active for variable resolution. This briefly opens
        // its editor via the change handler; we reset to the empty state immediately after.
        SelectedEnvironment = Environments.FirstOrDefault();

        MainContent = null;
        NewCollectionCommand.NotifyCanExecuteChanged();
    }

    private CollectionNodeViewModel BuildCollectionNode(YamletCollection collection)
    {
        var node = new CollectionNodeViewModel { Collection = collection, Name = collection.Name };
        PopulateChildren(node, collection, collection.Folders, collection.Requests);
        return node;
    }

    private void PopulateChildren(
        TreeNodeViewModel parent,
        YamletCollection collection,
        IEnumerable<YamletFolder> folders,
        IEnumerable<YamletRequest> requests)
    {
        foreach (var folder in folders)
        {
            var folderNode = new FolderNodeViewModel
            {
                Folder = folder,
                OwningCollection = collection,
                Name = folder.Name,
                Parent = parent,
            };
            PopulateChildren(folderNode, collection, folder.Folders, folder.Requests);
            parent.Children.Add(folderNode);
        }

        foreach (var request in requests)
        {
            parent.Children.Add(new RequestNodeViewModel
            {
                Request = request,
                OwningCollection = collection,
                ParentFolder = parent as FolderNodeViewModel is { } fn ? fn.Folder : null,
                Name = request.Name,
                Method = request.Method,
                Parent = parent,
            });
        }
    }

    /// <summary>
    /// Resolves the collection and (optional) folder the next add operation should
    /// target, based on the current selection.
    /// </summary>
    private bool TryResolveTarget(out YamletCollection? collection, out YamletFolder? folder, bool allowRequestParent)
    {
        collection = null;
        folder = null;

        switch (SelectedNode)
        {
            case CollectionNodeViewModel c:
                collection = c.Collection;
                return true;
            case FolderNodeViewModel f:
                collection = f.OwningCollection;
                folder = f.Folder;
                return true;
            case RequestNodeViewModel r when allowRequestParent:
                collection = r.OwningCollection;
                folder = r.ParentFolder;
                return true;
            default:
                // Fall back to the first collection if exactly one exists.
                if (Workspace?.Collections.Count == 1)
                {
                    collection = Workspace.Collections[0];
                    return true;
                }
                return false;
        }
    }

    private TreeNodeViewModel? FindNodeForFolderParent(YamletCollection collection, YamletFolder? folder)
    {
        var collectionNode = CollectionNodes.OfType<CollectionNodeViewModel>()
            .FirstOrDefault(n => ReferenceEquals(n.Collection, collection));
        if (collectionNode is null)
        {
            return null;
        }

        if (folder is null)
        {
            return collectionNode;
        }

        return FindFolderNode(collectionNode, folder);
    }

    private static TreeNodeViewModel? FindFolderNode(TreeNodeViewModel node, YamletFolder folder)
    {
        foreach (var child in node.Children)
        {
            if (child is FolderNodeViewModel fn && ReferenceEquals(fn.Folder, folder))
            {
                return fn;
            }

            var found = FindFolderNode(child, folder);
            if (found is not null)
            {
                return found;
            }
        }
        return null;
    }

    private async Task RunBusyAsync(string message, Func<Task> action)
    {
        IsBusy = true;
        StatusMessage = message;
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            StatusMessage = $"Error: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }
}

/// <summary>No-op dialog service used only by the design-time view-model constructor.</summary>
internal sealed class DesignDialogService : IDialogService
{
    public Task<string?> PickFolderAsync(string title) => Task.FromResult<string?>(null);
    public Task<string?> PromptTextAsync(string title, string prompt, string defaultValue = "") =>
        Task.FromResult<string?>(null);
}
