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
    private const int MaxVisibleTabs = 5;

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

        OpenTabs.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(HasOpenTabs));
            OnPropertyChanged(nameof(ShowMainEmptyState));
            RefreshTabPicker();
        };
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
    private YamletEnvironment? _selectedEnvironmentPicker;

    [ObservableProperty]
    private YamletWorkspace? _workspace;

    [ObservableProperty]
    private TreeNodeViewModel? _selectedNode;

    [ObservableProperty]
    private RequestEditorViewModel? _currentEditor;

    /// <summary>Open editor tabs for requests, environments, and collections.</summary>
    public ObservableCollection<OpenTabViewModel> OpenTabs { get; } = new();

    /// <summary>Most recently used tabs shown directly in the tab strip.</summary>
    public ObservableCollection<OpenTabViewModel> VisibleTabs { get; } = new();

    /// <summary>Older open tabs available from the tab picker.</summary>
    public ObservableCollection<OpenTabViewModel> OverflowTabs { get; } = new();

    /// <summary>The currently active tab; its <see cref="OpenTabViewModel.Content"/> fills the main panel.</summary>
    [ObservableProperty]
    private OpenTabViewModel? _selectedTab;

    [ObservableProperty]
    private OpenTabViewModel? _selectedOverflowTab;

    public bool HasOpenTabs => OpenTabs.Count > 0;
    public bool HasOverflowTabs => OverflowTabs.Count > 0;

    // Collapsible sidebar sections (accordion).
    [ObservableProperty]
    private bool _collectionsExpanded = true;

    [ObservableProperty]
    private bool _environmentsExpanded;

    [RelayCommand]
    private void ToggleCollections() => CollectionsExpanded = !CollectionsExpanded;

    [RelayCommand]
    private void ToggleEnvironments() => EnvironmentsExpanded = !EnvironmentsExpanded;

    /// <summary>
    /// Opens an environment in the main panel for viewing/editing. Selecting an
    /// environment also makes it the active one used to resolve {{variables}}.
    /// </summary>
    private bool _selectingEnvironmentFromPicker;

    partial void OnSelectedEnvironmentChanged(YamletEnvironment? value)
    {
        if (value is null)
        {
            SelectedEnvironmentPicker = null;
            return;
        }

        if (Workspace is not null)
        {
            _recent.RememberSelectedEnvironment(Workspace.RootPath, EnvKey(value) ?? value.Id);
        }

        if (!ReferenceEquals(SelectedEnvironmentPicker, value))
        {
            SelectedEnvironmentPicker = value;
        }

        if (_restoring || _selectingEnvironmentFromPicker)
        {
            return;
        }

        // Only open the editor tab when selection comes from the sidebar, not the
        // status-bar picker (which is for setting the active variable scope only).
        OpenEnvironmentTab(value);
    }

    partial void OnSelectedEnvironmentPickerChanged(YamletEnvironment? value)
    {
        if (ReferenceEquals(SelectedEnvironment, value))
        {
            return;
        }

        _selectingEnvironmentFromPicker = true;
        try
        {
            SelectedEnvironment = value;
        }
        finally
        {
            _selectingEnvironmentFromPicker = false;
        }
    }

    [ObservableProperty]
    private string _statusMessage = "Open or create a Yamlet workspace to begin.";

    [ObservableProperty]
    private bool _isBusy;

    public bool HasWorkspace => Workspace is not null;

    [ObservableProperty]
    private bool _isRestoringCachedWorkspace;

    public bool ShowNoWorkspaceMessage => !HasWorkspace && !IsRestoringCachedWorkspace;
    public bool ShowCollectionsTree => HasWorkspace && !IsRestoringCachedWorkspace;
    public bool ShowMainEmptyState => !HasOpenTabs && !IsRestoringCachedWorkspace;

    public string WorkspaceHeaderTitle => IsRestoringCachedWorkspace
        ? "Opening workspace..."
        : Workspace?.Name ?? "No workspace";

    public string WorkspaceTitle => Workspace is null
        ? "No workspace"
        : $"{Workspace.Name}  ·  {Workspace.RootPath}";

    partial void OnWorkspaceChanged(YamletWorkspace? value)
    {
        OnPropertyChanged(nameof(HasWorkspace));
        OnPropertyChanged(nameof(ShowNoWorkspaceMessage));
        OnPropertyChanged(nameof(ShowCollectionsTree));
        OnPropertyChanged(nameof(WorkspaceHeaderTitle));
        OnPropertyChanged(nameof(WorkspaceTitle));
    }

    partial void OnIsRestoringCachedWorkspaceChanged(bool value)
    {
        OnPropertyChanged(nameof(ShowNoWorkspaceMessage));
        OnPropertyChanged(nameof(ShowCollectionsTree));
        OnPropertyChanged(nameof(ShowMainEmptyState));
        OnPropertyChanged(nameof(WorkspaceHeaderTitle));
    }

    partial void OnSelectedNodeChanged(TreeNodeViewModel? value)
    {
        if (value is RequestNodeViewModel requestNode)
        {
            OpenRequestTab(requestNode);
        }
        else if (value is CollectionNodeViewModel collectionNode)
        {
            OpenCollectionTab(collectionNode);
        }
    }

    /// <summary>Reflects the active tab in <see cref="CurrentEditor"/> and tab highlight state.</summary>
    partial void OnSelectedTabChanged(OpenTabViewModel? value)
    {
        foreach (var tab in OpenTabs)
        {
            tab.IsActive = ReferenceEquals(tab, value);
        }

        if (value is not null)
        {
            MoveTabToMostRecent(value);
        }

        CurrentEditor = value?.Content as RequestEditorViewModel;
        PersistSession();
    }

    partial void OnSelectedOverflowTabChanged(OpenTabViewModel? value)
    {
        if (value is null)
        {
            return;
        }

        SelectedTab = value;
        SelectedOverflowTab = null;
    }

    // ---- Tab management ----------------------------------------------------

    private void OpenRequestTab(RequestNodeViewModel node)
    {
        if (TryActivate(node))
        {
            return;
        }

        var editor = new RequestEditorViewModel(
            node,
            _executor,
            _requestFileService,
            request => BuildContext(node.OwningCollection, request),
            request => BuildScriptVariables(node.OwningCollection, request),
            () => EffectiveCollectionAuth(node.OwningCollection),
            msg => StatusMessage = msg,
            _recent.LoadResponseSideBySide(),
            _recent.RememberResponseSideBySide,
            SetActiveEnvironmentVariableAsync,
            () => SelectedEnvironment?.Name,
            () => (node.OwningCollection.PreRequestScript, node.OwningCollection.PostResponseScript),
            _collectionService,
            _dialogs,
            request => Workspace is null
                ? null
                : _recent.LoadLastResponse(Workspace.RootPath, RequestCacheKey(request)),
            (request, response) =>
            {
                if (Workspace is not null)
                {
                    _recent.RememberLastResponse(Workspace.RootPath, RequestCacheKey(request), response);
                }
            });

        var tab = new OpenTabViewModel(
            node,
            editor,
            OpenTabKind.Request,
            node.Name,
            ActivateTab,
            CloseTab,
            CloseOtherTabs,
            CloseAllTabs,
            node.Method);
        editor.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(RequestEditorViewModel.Name))
            {
                tab.Title = editor.Name;
            }
            else if (e.PropertyName == nameof(RequestEditorViewModel.SelectedMethod))
            {
                tab.Method = editor.SelectedMethod;
            }
        };

        AddAndSelect(tab);
    }

    private void OpenCollectionTab(CollectionNodeViewModel node)
    {
        if (TryActivate(node))
        {
            return;
        }

        var settings = new CollectionSettingsViewModel(
            node.Collection,
            _collectionService,
            msg =>
            {
                node.Name = node.Collection.Name;
                StatusMessage = msg;
            },
            config => AcquireCollectionTokenAsync(node.Collection, config));

        var tab = new OpenTabViewModel(
            node,
            settings,
            OpenTabKind.Collection,
            node.Name,
            ActivateTab,
            CloseTab,
            CloseOtherTabs,
            CloseAllTabs);
        settings.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(CollectionSettingsViewModel.Name))
            {
                tab.Title = settings.Name;
            }
        };

        AddAndSelect(tab);
    }

    private void OpenEnvironmentTab(YamletEnvironment environment)
    {
        if (TryActivate(environment))
        {
            return;
        }

        var editor = new VariableSetEditorViewModel(
            environment.Name,
            "Environment variables. Use these names inside {{placeholders}}.",
            environment.Variables,
            () => _workspaceService.SaveEnvironmentAsync(environment),
            msg => StatusMessage = msg);

        AddAndSelect(new OpenTabViewModel(
            environment,
            editor,
            OpenTabKind.Environment,
            environment.Name,
            ActivateTab,
            CloseTab,
            CloseOtherTabs,
            CloseAllTabs));
    }

    /// <summary>Activates an already-open tab for <paramref name="key"/> if one exists.</summary>
    private bool TryActivate(object key)
    {
        var existing = OpenTabs.FirstOrDefault(t => Equals(t.Key, key));
        if (existing is null)
        {
            return false;
        }

        SelectedTab = existing;
        return true;
    }

    private void AddAndSelect(OpenTabViewModel tab)
    {
        OpenTabs.Add(tab);
        SelectedTab = tab;
    }

    private void ActivateTab(OpenTabViewModel tab) => SelectedTab = tab;

    private void CloseTab(OpenTabViewModel tab)
    {
        var index = OpenTabs.IndexOf(tab);
        OpenTabs.Remove(tab);
        VisibleTabs.Remove(tab);
        OverflowTabs.Remove(tab);

        if (ReferenceEquals(SelectedTab, tab))
        {
            SelectedTab = OpenTabs.Count == 0 ? null : OpenTabs[Math.Min(index, OpenTabs.Count - 1)];
        }

        RefreshTabPicker();
        PersistSession();
    }

    private void CloseOtherTabs(OpenTabViewModel tab)
    {
        foreach (var other in OpenTabs.Where(t => !ReferenceEquals(t, tab)).ToList())
        {
            OpenTabs.Remove(other);
            VisibleTabs.Remove(other);
            OverflowTabs.Remove(other);
        }

        SelectedTab = OpenTabs.Contains(tab) ? tab : OpenTabs.FirstOrDefault();
        RefreshTabPicker();
        PersistSession();
    }

    private void CloseAllTabs()
    {
        OpenTabs.Clear();
        VisibleTabs.Clear();
        OverflowTabs.Clear();
        SelectedTab = null;
        CurrentEditor = null;
        RefreshTabPicker();
        PersistSession();
    }

    private void MoveTabToMostRecent(OpenTabViewModel tab)
    {
        VisibleTabs.Remove(tab);
        OverflowTabs.Remove(tab);
        VisibleTabs.Insert(0, tab);
        RefreshTabPicker();
    }

    private void RefreshTabPicker()
    {
        foreach (var tab in OpenTabs.Where(tab => !VisibleTabs.Contains(tab) && !OverflowTabs.Contains(tab)).ToList())
        {
            OverflowTabs.Add(tab);
        }

        foreach (var tab in VisibleTabs.Concat(OverflowTabs).Where(tab => !OpenTabs.Contains(tab)).ToList())
        {
            VisibleTabs.Remove(tab);
            OverflowTabs.Remove(tab);
        }

        while (VisibleTabs.Count > MaxVisibleTabs)
        {
            var oldestVisible = VisibleTabs[^1];
            VisibleTabs.RemoveAt(VisibleTabs.Count - 1);
            OverflowTabs.Insert(0, oldestVisible);
        }

        while (VisibleTabs.Count < MaxVisibleTabs && OverflowTabs.Count > 0)
        {
            var newestOverflow = OverflowTabs[0];
            OverflowTabs.RemoveAt(0);
            VisibleTabs.Add(newestOverflow);
        }

        OnPropertyChanged(nameof(HasOverflowTabs));
    }

    // ---- Session persistence (open tabs + active tab) ----------------------

    private bool _restoring;

    private static string? EnvKey(YamletEnvironment? environment) =>
        environment is null ? null : (environment.FilePath ?? environment.Name);

    private static string KindString(OpenTabKind kind) => kind switch
    {
        OpenTabKind.Request => "request",
        OpenTabKind.Environment => "environment",
        OpenTabKind.Collection => "collection",
        _ => string.Empty,
    };

    private static string? TabPersistKey(OpenTabViewModel tab) => tab.Kind switch
    {
        OpenTabKind.Request => (tab.Key as RequestNodeViewModel)?.Request.SourceFilePath,
        OpenTabKind.Environment => EnvKey(tab.Key as YamletEnvironment),
        OpenTabKind.Collection => (tab.Key as CollectionNodeViewModel)?.Collection.FilePath,
        _ => null,
    };

    private static string RequestCacheKey(YamletRequest request) =>
        !string.IsNullOrWhiteSpace(request.SourceFilePath)
            ? request.SourceFilePath!
            : request.Id;

    /// <summary>Saves the current open tabs and active tab for the workspace.</summary>
    private void PersistSession()
    {
        if (_restoring || Workspace is null)
        {
            return;
        }

        var session = new WorkspaceSession();
        foreach (var tab in OpenTabs)
        {
            var key = TabPersistKey(tab);
            if (key is null)
            {
                continue; // unsaved (no file yet) — can't be restored, so skip
            }

            if (ReferenceEquals(tab, SelectedTab))
            {
                session.ActiveTabIndex = session.OpenTabs.Count;
            }

            session.OpenTabs.Add(new OpenTabRef { Kind = KindString(tab.Kind), Key = key });
        }

        _recent.SaveSession(Workspace.RootPath, session);
    }

    /// <summary>Reopens the tabs saved for this workspace and restores the active one.</summary>
    private void RestoreSession(YamletWorkspace workspace)
    {
        var session = _recent.LoadSession(workspace.RootPath);
        if (session.OpenTabs.Count == 0)
        {
            return;
        }

        var requestNodes = new Dictionary<string, RequestNodeViewModel>(StringComparer.OrdinalIgnoreCase);
        foreach (var node in EnumerateRequestNodes())
        {
            if (!string.IsNullOrEmpty(node.Request.SourceFilePath))
            {
                requestNodes[node.Request.SourceFilePath!] = node;
            }
        }

        foreach (var tabRef in session.OpenTabs)
        {
            switch (tabRef.Kind)
            {
                case "request":
                    if (requestNodes.TryGetValue(tabRef.Key, out var requestNode))
                    {
                        OpenRequestTab(requestNode);
                    }
                    break;
                case "environment":
                    var environment = Environments.FirstOrDefault(e =>
                        string.Equals(EnvKey(e), tabRef.Key, StringComparison.OrdinalIgnoreCase));
                    if (environment is not null)
                    {
                        OpenEnvironmentTab(environment);
                    }
                    break;
                case "collection":
                    var collectionNode = CollectionNodes.OfType<CollectionNodeViewModel>()
                        .FirstOrDefault(n => string.Equals(n.Collection.FilePath, tabRef.Key, StringComparison.OrdinalIgnoreCase));
                    if (collectionNode is not null)
                    {
                        OpenCollectionTab(collectionNode);
                    }
                    break;
            }
        }

        SelectedTab = session.ActiveTabIndex >= 0 && session.ActiveTabIndex < OpenTabs.Count
            ? OpenTabs[session.ActiveTabIndex]
            : OpenTabs.FirstOrDefault();
    }

    private IEnumerable<RequestNodeViewModel> EnumerateRequestNodes()
    {
        IEnumerable<RequestNodeViewModel> Walk(TreeNodeViewModel node)
        {
            if (node is RequestNodeViewModel request)
            {
                yield return request;
            }

            foreach (var child in node.Children)
            {
                foreach (var descendant in Walk(child))
                {
                    yield return descendant;
                }
            }
        }

        return CollectionNodes.SelectMany(Walk);
    }

    private static IEnumerable<RequestNodeViewModel> EnumerateRequestNodes(TreeNodeViewModel node)
    {
        if (node is RequestNodeViewModel request)
        {
            yield return request;
        }

        foreach (var child in node.Children)
        {
            foreach (var descendant in EnumerateRequestNodes(child))
            {
                yield return descendant;
            }
        }
    }

    private VariableContext BuildContext(YamletCollection collection, YamletRequest request) =>
        VariableContext.Create(
            globals: Workspace?.Globals,
            environment: SelectedEnvironment?.Variables,
            collection: collection.Variables,
            request: request.Variables);

    private RequestScriptVariables BuildScriptVariables(YamletCollection collection, YamletRequest request) =>
        new(
            BuildContext(collection, request),
            globals: Workspace?.Globals,
            environment: SelectedEnvironment?.Variables,
            collection: collection.Variables,
            request: request.Variables,
            persistAsync: scopes => PersistScriptVariableScopesAsync(scopes, collection, request));

    private async Task PersistScriptVariableScopesAsync(
        IReadOnlySet<RequestScriptVariableScope> scopes,
        YamletCollection collection,
        YamletRequest request)
    {
        if (Workspace is not null && scopes.Contains(RequestScriptVariableScope.Globals))
        {
            await _workspaceService.SaveGlobalsAsync(Workspace);
        }
        if (SelectedEnvironment is not null && scopes.Contains(RequestScriptVariableScope.Environment))
        {
            await _workspaceService.SaveEnvironmentAsync(SelectedEnvironment);
        }
        if (scopes.Contains(RequestScriptVariableScope.Collection))
        {
            await _collectionService.SaveCollectionAsync(collection);
        }
        if (scopes.Contains(RequestScriptVariableScope.Local))
        {
            await _requestFileService.SaveRequestAsync(request);
        }
    }

    /// <summary>
    /// Sets a variable's value in the active environment and persists it. Used by the
    /// body editor's inline variable inspector. Adds the variable if it doesn't exist.
    /// </summary>
    private async Task SetActiveEnvironmentVariableAsync(string key, string value)
    {
        if (SelectedEnvironment is null)
        {
            StatusMessage = "Select an environment before setting a variable.";
            return;
        }

        var existing = SelectedEnvironment.Variables
            .FirstOrDefault(v => string.Equals(v.Key, key, StringComparison.OrdinalIgnoreCase));
        if (existing is null)
        {
            SelectedEnvironment.Variables.Add(new YamletVariable { Key = key, Value = value, Enabled = true });
        }
        else
        {
            existing.Value = value;
            existing.Enabled = true;
        }

        await _workspaceService.SaveEnvironmentAsync(SelectedEnvironment);
        StatusMessage = $"Set {{{{{key}}}}} in {SelectedEnvironment.Name}";
    }

    private static YamletAuth? EffectiveCollectionAuth(YamletCollection collection) =>
        collection.Auth.Type != YamletAuthType.None
            ? collection.Auth
            : null;

    private readonly VariableResolver _oauthResolver = new();
    private OAuth2BrowserFlow? _browserFlow;

    /// <summary>
    /// Obtains an OAuth2 access token for the collection-settings "Get New Access Token"
    /// button: client-credentials are fetched from the token endpoint; the auth-code grant
    /// runs the interactive browser flow. Placeholders resolve against the collection +
    /// active environment + globals.
    /// </summary>
    private async Task<string> AcquireCollectionTokenAsync(YamletCollection collection, YamletOAuth2 config)
    {
        var context = VariableContext.Create(
            globals: Workspace?.Globals,
            environment: SelectedEnvironment?.Variables,
            collection: collection.Variables,
            request: null);

        var resolved = new YamletOAuth2
        {
            GrantType = config.GrantType,
            AddTokenTo = config.AddTokenTo,
            ClientAuthentication = config.ClientAuthentication,
            ChallengeAlgorithm = config.ChallengeAlgorithm,
            HeaderPrefix = config.HeaderPrefix,
            AccessToken = _oauthResolver.Resolve(config.AccessToken, context),
            AccessTokenUrl = _oauthResolver.Resolve(config.AccessTokenUrl, context),
            AuthUrl = _oauthResolver.Resolve(config.AuthUrl, context),
            ClientId = _oauthResolver.Resolve(config.ClientId, context),
            ClientSecret = _oauthResolver.Resolve(config.ClientSecret, context),
            Scope = _oauthResolver.Resolve(config.Scope, context),
            RedirectUri = _oauthResolver.Resolve(config.RedirectUri, context),
        };

        if (resolved.GrantType == OAuth2GrantType.ClientCredentials)
        {
            return await _executor.OAuth2.GetClientCredentialsTokenAsync(resolved, CancellationToken.None);
        }

        _browserFlow ??= new OAuth2BrowserFlow(_executor.OAuth2);
        var result = await _browserFlow.AuthorizeAsync(resolved, CancellationToken.None);
        return result.AccessToken;
    }

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

        IsRestoringCachedWorkspace = true;
        try
        {
            await RunBusyAsync("Restoring last workspace…", async () =>
            {
                var workspace = await _workspaceService.OpenWorkspaceAsync(lastPath);
                LoadWorkspace(workspace);
                StatusMessage = $"Reopened {workspace.Name} ({workspace.Collections.Count} collection(s))";
            });
        }
        finally
        {
            IsRestoringCachedWorkspace = false;
        }
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
    private void CollapseCollections()
    {
        foreach (var node in CollectionNodes)
        {
            CollapseNode(node);
        }

        StatusMessage = "Collapsed collections.";
    }

    [RelayCommand]
    private async Task NewFolderForNodeAsync(TreeNodeViewModel? node)
    {
        if (!TryResolveTargetForNode(node, out var collection, out var parentFolder, allowRequestParent: false))
        {
            StatusMessage = "Select a collection or folder first.";
            return;
        }

        await CreateFolderAsync(collection!, parentFolder);
    }

    [RelayCommand]
    private async Task NewRequestForNodeAsync(TreeNodeViewModel? node)
    {
        if (!TryResolveTargetForNode(node, out var collection, out var parentFolder, allowRequestParent: true))
        {
            StatusMessage = "Select a collection or folder first.";
            return;
        }

        await CreateRequestAsync(collection!, parentFolder);
    }

    [RelayCommand]
    private void RunNode(TreeNodeViewModel? node)
    {
        if (node is not CollectionNodeViewModel and not FolderNodeViewModel)
        {
            StatusMessage = "Select a collection or folder to run.";
            return;
        }

        var requests = EnumerateRequestNodes(node).ToList();
        if (requests.Count == 0)
        {
            StatusMessage = $"No requests found in '{node.Name}'.";
            return;
        }

        OpenRunnerTab(node, requests);
    }

    [RelayCommand]
    private void DeleteRequest(RequestNodeViewModel? node)
    {
        if (node is null)
        {
            return;
        }

        (node.Parent?.Children ?? CollectionNodes).Remove(node);
        (node.ParentFolder?.Requests ?? node.OwningCollection.Requests).Remove(node.Request);

        if (!string.IsNullOrWhiteSpace(node.Request.SourceFilePath) && File.Exists(node.Request.SourceFilePath))
        {
            File.Delete(node.Request.SourceFilePath);
        }

        foreach (var tab in OpenTabs.Where(t => ReferenceEquals(t.Key, node)).ToList())
        {
            CloseTab(tab);
        }

        if (ReferenceEquals(SelectedNode, node))
        {
            SelectedNode = null;
        }

        StatusMessage = $"Deleted request '{node.Name}'.";
    }

    [RelayCommand]
    private async Task RenameNodeAsync(TreeNodeViewModel? node)
    {
        if (node is null)
        {
            return;
        }

        var name = await _dialogs.PromptTextAsync("Rename", "Name", node.Name);
        if (string.IsNullOrWhiteSpace(name) || string.Equals(name, node.Name, StringComparison.Ordinal))
        {
            return;
        }

        switch (node)
        {
            case CollectionNodeViewModel collectionNode:
                await RenameCollectionAsync(collectionNode, name);
                break;
            case FolderNodeViewModel folderNode:
                await RenameFolderAsync(folderNode, name);
                break;
            case RequestNodeViewModel requestNode:
                await RenameRequestAsync(requestNode, name);
                break;
        }

        StatusMessage = $"Renamed to '{name}'.";
    }

    [RelayCommand]
    private void DeleteNode(TreeNodeViewModel? node)
    {
        switch (node)
        {
            case CollectionNodeViewModel collectionNode:
                Workspace?.Collections.Remove(collectionNode.Collection);
                CollectionNodes.Remove(collectionNode);
                DeleteDirectory(collectionNode.Collection.DirectoryPath);
                CloseTabsForNode(collectionNode);
                if (ReferenceEquals(SelectedNode, collectionNode))
                {
                    SelectedNode = null;
                }
                StatusMessage = $"Deleted collection '{collectionNode.Name}'.";
                break;

            case FolderNodeViewModel folderNode:
                ((folderNode.Parent as FolderNodeViewModel)?.Folder.Folders ?? folderNode.OwningCollection.Folders)
                    .Remove(folderNode.Folder);
                RemoveUiNode(folderNode);
                DeleteDirectory(folderNode.Folder.DirectoryPath);
                CloseTabsForNode(folderNode);
                if (ReferenceEquals(SelectedNode, folderNode))
                {
                    SelectedNode = null;
                }
                StatusMessage = $"Deleted folder '{folderNode.Name}'.";
                break;

            case RequestNodeViewModel requestNode:
                DeleteRequest(requestNode);
                break;
        }
    }

    [RelayCommand]
    private async Task DuplicateRequestAsync(RequestNodeViewModel? node)
    {
        if (node is null)
        {
            return;
        }

        var copy = CloneRequest(node.Request);
        copy.Name = $"{node.Request.Name} Copy";
        copy.SourceFilePath = PathNaming.UniqueFilePath(
            TargetDirectory(node.OwningCollection, node.ParentFolder),
            PathNaming.Slugify(copy.Name, "request") + RequestFileService.FileExtension);

        var siblings = node.ParentFolder?.Requests ?? node.OwningCollection.Requests;
        var requestIndex = siblings.IndexOf(node.Request);
        siblings.Insert(requestIndex < 0 ? siblings.Count : requestIndex + 1, copy);
        await _requestFileService.SaveRequestAsync(copy);

        var parentNode = node.Parent;
        var copyNode = new RequestNodeViewModel
        {
            Request = copy,
            OwningCollection = node.OwningCollection,
            ParentFolder = node.ParentFolder,
            Name = copy.Name,
            Method = copy.Method,
            Parent = parentNode,
        };

        var uiSiblings = parentNode?.Children ?? CollectionNodes;
        var nodeIndex = uiSiblings.IndexOf(node);
        uiSiblings.Insert(nodeIndex < 0 ? uiSiblings.Count : nodeIndex + 1, copyNode);
        SelectedNode = copyNode;
        StatusMessage = $"Duplicated request '{node.Name}'.";
    }

    public async Task MoveTreeNodeAsync(TreeNodeViewModel source, TreeNodeViewModel target)
    {
        if (source is RequestNodeViewModel requestNode)
        {
            await MoveRequestNodeAsync(requestNode, target);
        }
        else if (source is FolderNodeViewModel folderNode)
        {
            await MoveFolderNodeAsync(folderNode, target);
        }
    }

    private async Task MoveRequestNodeAsync(RequestNodeViewModel source, TreeNodeViewModel target)
    {
        ResolveDropTarget(target, out var targetCollection, out var targetFolder, out var targetParentNode, out var insertBefore);
        var oldRequests = source.ParentFolder?.Requests ?? source.OwningCollection.Requests;
        var newRequests = targetFolder?.Requests ?? targetCollection.Requests;
        oldRequests.Remove(source.Request);

        var insertIndex = insertBefore is not null &&
            insertBefore.ParentFolder == targetFolder &&
            ReferenceEquals(insertBefore.OwningCollection, targetCollection)
            ? newRequests.IndexOf(insertBefore.Request)
            : -1;
        if (insertIndex < 0)
        {
            insertIndex = newRequests.Count;
        }
        newRequests.Insert(insertIndex, source.Request);

        MoveRequestFile(source.Request, targetCollection, targetFolder);

        RemoveUiNode(source);
        source.OwningCollection = targetCollection;
        source.ParentFolder = targetFolder;
        source.Parent = targetParentNode;
        InsertUiNode(source, targetParentNode, insertBefore);

        await _requestFileService.SaveRequestAsync(source.Request);
        StatusMessage = $"Moved request '{source.Name}'.";
    }

    private async Task MoveFolderNodeAsync(FolderNodeViewModel source, TreeNodeViewModel target)
    {
        var oldCollection = source.OwningCollection;
        ResolveDropTarget(target, out var targetCollection, out var targetFolder, out var targetParentNode, out var insertBeforeRequest);
        TreeNodeViewModel? insertBefore = insertBeforeRequest;
        if (target is FolderNodeViewModel targetFolderNode)
        {
            targetFolder = (targetFolderNode.Parent as FolderNodeViewModel)?.Folder;
            targetCollection = targetFolderNode.OwningCollection;
            targetParentNode = targetFolderNode.Parent;
            insertBefore = targetFolderNode;
        }
        else if (insertBeforeRequest is not null)
        {
            targetFolder = insertBeforeRequest.ParentFolder;
            targetCollection = insertBeforeRequest.OwningCollection;
            targetParentNode = insertBeforeRequest.Parent;
        }

        var oldFolders = (source.Parent as FolderNodeViewModel)?.Folder.Folders ?? source.OwningCollection.Folders;
        var newFolders = targetFolder?.Folders ?? targetCollection.Folders;
        oldFolders.Remove(source.Folder);

        var insertIndex = insertBefore is FolderNodeViewModel folderBefore &&
            ReferenceEquals(folderBefore.Parent, targetParentNode)
                ? newFolders.IndexOf(folderBefore.Folder)
                : -1;
        if (insertIndex < 0)
        {
            insertIndex = newFolders.Count;
        }
        newFolders.Insert(insertIndex, source.Folder);

        MoveFolderDirectory(source.Folder, targetCollection, targetFolder);

        RemoveUiNode(source);
        source.Parent = targetParentNode;
        SetOwningCollection(source, targetCollection);
        InsertUiNode(source, targetParentNode, insertBefore);

        await _collectionService.SaveCollectionAsync(oldCollection);
        if (!ReferenceEquals(oldCollection, targetCollection))
        {
            await _collectionService.SaveCollectionAsync(targetCollection);
        }
        StatusMessage = $"Moved folder '{source.Name}'.";
    }

    private static YamletRequest CloneRequest(YamletRequest request) => new()
    {
        Id = Guid.NewGuid().ToString(),
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
    };

    private static string TargetDirectory(YamletCollection collection, YamletFolder? folder) =>
        folder?.DirectoryPath
        ?? collection.DirectoryPath
        ?? throw new InvalidOperationException("Target has no directory.");

    private async Task RenameCollectionAsync(CollectionNodeViewModel node, string name)
    {
        node.Collection.Name = name;
        node.Name = name;
        if (!string.IsNullOrWhiteSpace(Workspace?.CollectionsPath)
            && !string.IsNullOrWhiteSpace(node.Collection.DirectoryPath))
        {
            var targetPath = PathNaming.UniqueDirectoryPath(Workspace.CollectionsPath, PathNaming.Slugify(name, "collection"));
            if (!string.Equals(node.Collection.DirectoryPath, targetPath, StringComparison.OrdinalIgnoreCase))
            {
                Directory.Move(node.Collection.DirectoryPath, targetPath);
                node.Collection.DirectoryPath = targetPath;
                node.Collection.FilePath = Path.Combine(targetPath, CollectionService.MetadataFileName);
                RefreshCollectionPaths(node.Collection);
            }
        }

        await _collectionService.SaveCollectionAsync(node.Collection);
    }

    private async Task RenameFolderAsync(FolderNodeViewModel node, string name)
    {
        node.Folder.Name = name;
        node.Name = name;

        var parentDir = TargetDirectory(node.OwningCollection, (node.Parent as FolderNodeViewModel)?.Folder);
        if (!string.IsNullOrWhiteSpace(node.Folder.DirectoryPath))
        {
            var targetPath = PathNaming.UniqueDirectoryPath(parentDir, PathNaming.Slugify(name, "folder"));
            if (!string.Equals(node.Folder.DirectoryPath, targetPath, StringComparison.OrdinalIgnoreCase))
            {
                Directory.Move(node.Folder.DirectoryPath, targetPath);
                node.Folder.DirectoryPath = targetPath;
                RefreshRequestPaths(node.Folder);
            }
        }

        await _collectionService.SaveCollectionAsync(node.OwningCollection);
    }

    private async Task RenameRequestAsync(RequestNodeViewModel node, string name)
    {
        node.Request.Name = name;
        node.Name = name;

        var targetDir = TargetDirectory(node.OwningCollection, node.ParentFolder);
        var targetPath = PathNaming.UniqueFilePath(
            targetDir,
            PathNaming.Slugify(name, "request") + RequestFileService.FileExtension);
        if (!string.IsNullOrWhiteSpace(node.Request.SourceFilePath)
            && File.Exists(node.Request.SourceFilePath)
            && !string.Equals(node.Request.SourceFilePath, targetPath, StringComparison.OrdinalIgnoreCase))
        {
            File.Move(node.Request.SourceFilePath, targetPath);
            node.Request.SourceFilePath = targetPath;
        }

        await _requestFileService.SaveRequestAsync(node.Request);
    }

    private static void ResolveDropTarget(
        TreeNodeViewModel target,
        out YamletCollection collection,
        out YamletFolder? folder,
        out TreeNodeViewModel? parentNode,
        out RequestNodeViewModel? insertBefore)
    {
        switch (target)
        {
            case CollectionNodeViewModel collectionNode:
                collection = collectionNode.Collection;
                folder = null;
                parentNode = collectionNode;
                insertBefore = null;
                break;
            case FolderNodeViewModel folderNode:
                collection = folderNode.OwningCollection;
                folder = folderNode.Folder;
                parentNode = folderNode;
                insertBefore = null;
                break;
            case RequestNodeViewModel requestNode:
                collection = requestNode.OwningCollection;
                folder = requestNode.ParentFolder;
                parentNode = requestNode.Parent;
                insertBefore = requestNode;
                break;
            default:
                throw new InvalidOperationException("Unsupported drop target.");
        }
    }

    private void MoveRequestFile(YamletRequest request, YamletCollection targetCollection, YamletFolder? targetFolder)
    {
        var targetDir = TargetDirectory(targetCollection, targetFolder);
        Directory.CreateDirectory(targetDir);

        var currentPath = request.SourceFilePath;
        var fileName = string.IsNullOrWhiteSpace(currentPath)
            ? PathNaming.Slugify(request.Name, "request") + RequestFileService.FileExtension
            : Path.GetFileName(currentPath);
        var desiredPath = Path.Combine(targetDir, fileName);

        if (string.Equals(currentPath, desiredPath, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var targetPath = File.Exists(desiredPath)
            ? PathNaming.UniqueFilePath(targetDir, fileName)
            : desiredPath;

        if (!string.IsNullOrWhiteSpace(currentPath) && File.Exists(currentPath))
        {
            File.Move(currentPath, targetPath);
        }

        request.SourceFilePath = targetPath;
    }

    private static void MoveFolderDirectory(YamletFolder folder, YamletCollection targetCollection, YamletFolder? targetFolder)
    {
        var targetParentDir = TargetDirectory(targetCollection, targetFolder);
        Directory.CreateDirectory(targetParentDir);
        if (string.IsNullOrWhiteSpace(folder.DirectoryPath))
        {
            folder.DirectoryPath = PathNaming.UniqueDirectoryPath(targetParentDir, PathNaming.Slugify(folder.Name, "folder"));
            Directory.CreateDirectory(folder.DirectoryPath);
            return;
        }

        var desiredPath = Path.Combine(targetParentDir, Path.GetFileName(folder.DirectoryPath));
        if (string.Equals(folder.DirectoryPath, desiredPath, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var targetPath = Directory.Exists(desiredPath)
            ? PathNaming.UniqueDirectoryPath(targetParentDir, Path.GetFileName(folder.DirectoryPath))
            : desiredPath;
        Directory.Move(folder.DirectoryPath, targetPath);
        folder.DirectoryPath = targetPath;
        RefreshRequestPaths(folder);
    }

    private static void RefreshRequestPaths(YamletFolder folder)
    {
        foreach (var request in folder.Requests)
        {
            if (!string.IsNullOrWhiteSpace(request.SourceFilePath))
            {
                request.SourceFilePath = Path.Combine(folder.DirectoryPath!, Path.GetFileName(request.SourceFilePath));
            }
        }

        foreach (var child in folder.Folders)
        {
            if (!string.IsNullOrWhiteSpace(child.DirectoryPath))
            {
                child.DirectoryPath = Path.Combine(folder.DirectoryPath!, Path.GetFileName(child.DirectoryPath));
            }
            RefreshRequestPaths(child);
        }
    }

    private static void RefreshCollectionPaths(YamletCollection collection)
    {
        foreach (var request in collection.Requests)
        {
            if (!string.IsNullOrWhiteSpace(request.SourceFilePath))
            {
                request.SourceFilePath = Path.Combine(collection.DirectoryPath!, Path.GetFileName(request.SourceFilePath));
            }
        }

        foreach (var folder in collection.Folders)
        {
            if (!string.IsNullOrWhiteSpace(folder.DirectoryPath))
            {
                folder.DirectoryPath = Path.Combine(collection.DirectoryPath!, Path.GetFileName(folder.DirectoryPath));
            }
            RefreshRequestPaths(folder);
        }
    }

    private static void DeleteDirectory(string? path)
    {
        if (!string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }
    }

    private void CloseTabsForNode(TreeNodeViewModel node)
    {
        var nodes = new HashSet<TreeNodeViewModel>(EnumerateTreeNodes(node), ReferenceEqualityComparer.Instance);
        foreach (var tab in OpenTabs.Where(t => t.Key is TreeNodeViewModel tabNode && nodes.Contains(tabNode)).ToList())
        {
            CloseTab(tab);
        }
    }

    private static IEnumerable<TreeNodeViewModel> EnumerateTreeNodes(TreeNodeViewModel node)
    {
        yield return node;
        foreach (var child in node.Children)
        {
            foreach (var descendant in EnumerateTreeNodes(child))
            {
                yield return descendant;
            }
        }
    }

    private void RemoveUiNode(TreeNodeViewModel node) =>
        (node.Parent?.Children ?? CollectionNodes).Remove(node);

    private void InsertUiNode(TreeNodeViewModel node, TreeNodeViewModel? parentNode, TreeNodeViewModel? insertBefore)
    {
        var siblings = parentNode?.Children ?? CollectionNodes;
        var index = insertBefore is not null && ReferenceEquals(insertBefore.Parent, parentNode)
            ? siblings.IndexOf(insertBefore)
            : -1;
        siblings.Insert(index < 0 ? siblings.Count : index, node);
        if (parentNode is not null)
        {
            parentNode.IsExpanded = true;
        }
    }

    private static void SetOwningCollection(FolderNodeViewModel folderNode, YamletCollection collection)
    {
        folderNode.OwningCollection = collection;
        foreach (var child in folderNode.Children)
        {
            switch (child)
            {
                case FolderNodeViewModel folder:
                    SetOwningCollection(folder, collection);
                    break;
                case RequestNodeViewModel request:
                    request.OwningCollection = collection;
                    break;
            }
        }
    }

    private void OpenRunnerTab(TreeNodeViewModel node, IReadOnlyList<RequestNodeViewModel> requests)
    {
        var key = ("runner", node);
        if (TryActivate(key))
        {
            return;
        }

        var runner = new RunnerViewModel(
            $"{node.Name} - Runner",
            requests,
            _executor,
            requestNode => BuildContext(requestNode.OwningCollection, requestNode.Request),
            requestNode => BuildScriptVariables(requestNode.OwningCollection, requestNode.Request),
            requestNode => EffectiveCollectionAuth(requestNode.OwningCollection),
            () => SelectedEnvironment?.Name,
            msg => StatusMessage = msg);

        AddAndSelect(new OpenTabViewModel(
            key,
            runner,
            OpenTabKind.Runner,
            "Runner",
            ActivateTab,
            CloseTab,
            CloseOtherTabs,
            CloseAllTabs));
    }

    [RelayCommand]
    private async Task NewFolderAsync()
    {
        if (!TryResolveTarget(out var collection, out var parentFolder, allowRequestParent: true))
        {
            StatusMessage = "Select a collection or folder first.";
            return;
        }

        await CreateFolderAsync(collection!, parentFolder);
    }

    [RelayCommand]
    private async Task NewRequestAsync()
    {
        if (!TryResolveTarget(out var collection, out var parentFolder, allowRequestParent: true))
        {
            StatusMessage = "Select a collection or folder first.";
            return;
        }

        await CreateRequestAsync(collection!, parentFolder);
    }

    private async Task CreateFolderAsync(YamletCollection collection, YamletFolder? parentFolder)
    {
        var name = await _dialogs.PromptTextAsync("New Folder", "Folder name", "New Folder");
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var folder = _collectionService.CreateFolder(collection, parentFolder, name);
        var parentNode = FindNodeForFolderParent(collection, parentFolder);
        var node = new FolderNodeViewModel
        {
            Folder = folder,
            OwningCollection = collection,
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

    private async Task CreateRequestAsync(YamletCollection collection, YamletFolder? parentFolder)
    {
        var name = await _dialogs.PromptTextAsync("New Request", "Request name", "New Request");
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var request = _collectionService.CreateRequest(collection, parentFolder, name);
        await _requestFileService.SaveRequestAsync(request);

        var parentNode = FindNodeForFolderParent(collection, parentFolder);
        var node = new RequestNodeViewModel
        {
            Request = request,
            OwningCollection = collection,
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
        _restoring = true;
        try
        {
            Workspace = workspace;
            CurrentEditor = null;
            SelectedNode = null;
            OpenTabs.Clear();
            VisibleTabs.Clear();
            OverflowTabs.Clear();
            SelectedTab = null;

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

            var cachedEnvironmentKey = _recent.LoadSelectedEnvironmentId(workspace.RootPath);
            SelectedEnvironment = Environments.FirstOrDefault(e =>
                    string.Equals(EnvKey(e), cachedEnvironmentKey, StringComparison.OrdinalIgnoreCase)
                    || e.Id == cachedEnvironmentKey) // accept the legacy id-based key
                ?? Environments.FirstOrDefault();

            RestoreSession(workspace);

            NewCollectionCommand.NotifyCanExecuteChanged();
        }
        finally
        {
            _restoring = false;
        }

        PersistSession();
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

    private bool TryResolveTargetForNode(
        TreeNodeViewModel? node,
        out YamletCollection? collection,
        out YamletFolder? folder,
        bool allowRequestParent)
    {
        collection = null;
        folder = null;

        switch (node)
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
                return TryResolveTarget(out collection, out folder, allowRequestParent);
        }
    }

    private static void CollapseNode(TreeNodeViewModel node)
    {
        node.IsExpanded = false;
        foreach (var child in node.Children)
        {
            CollapseNode(child);
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
    public Task<string?> PickFileAsync(string title) => Task.FromResult<string?>(null);
    public Task<string?> PromptTextAsync(string title, string prompt, string defaultValue = "") =>
        Task.FromResult<string?>(null);
}
