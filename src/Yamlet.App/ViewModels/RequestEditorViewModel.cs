using System.Text;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Controls;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Edits a single request and runs it. Holds observable copies of the request's
/// fields, maps them back to the <see cref="YamletRequest"/> model on save/send, and
/// surfaces the resulting <see cref="YamletResponse"/>.
/// </summary>
public sealed partial class RequestEditorViewModel : ViewModelBase, IVariableSource
{
    private readonly RequestExecutor _executor;
    private readonly RequestFileService _requestFiles;
    private readonly Func<YamletRequest, VariableContext> _contextFactory;
    private readonly Func<YamletRequest, RequestScriptVariables> _scriptVariablesFactory;
    private readonly Func<YamletAuth?> _collectionAuthFactory;
    private readonly Func<(string Pre, string Post)> _collectionScriptsFactory;
    private readonly Action<string>? _status;
    private readonly Action<bool>? _persistLayout;
    private readonly Func<string, string, Task>? _setEnvironmentVariableAsync;
    private readonly Func<string?>? _activeEnvironmentName;
    private readonly RequestNodeViewModel _node;
    private CancellationTokenSource? _inflight;
    private VariableContext? _variableCache;

    public static readonly string[] Methods =
        { "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" };

    public IReadOnlyList<LabeledOption<YamletBodyType>> BodyTypes { get; } = new[]
    {
        new LabeledOption<YamletBodyType>("none", YamletBodyType.None),
        new LabeledOption<YamletBodyType>("raw", YamletBodyType.Raw),
        new LabeledOption<YamletBodyType>("JSON", YamletBodyType.Json),
        new LabeledOption<YamletBodyType>("form-data", YamletBodyType.FormData),
        new LabeledOption<YamletBodyType>("x-www-form-urlencoded", YamletBodyType.UrlEncoded),
    };

    public IReadOnlyList<LabeledOption<YamletAuthType>> AuthTypes { get; } = new[]
    {
        new LabeledOption<YamletAuthType>("Inherit from Collection", YamletAuthType.Inherit),
        new LabeledOption<YamletAuthType>("No Auth", YamletAuthType.None),
        new LabeledOption<YamletAuthType>("Bearer Token", YamletAuthType.Bearer),
        new LabeledOption<YamletAuthType>("Basic Auth", YamletAuthType.Basic),
        new LabeledOption<YamletAuthType>("API Key", YamletAuthType.ApiKey),
        new LabeledOption<YamletAuthType>("Cookie", YamletAuthType.Cookie),
    };

    public IReadOnlyList<LabeledOption<ApiKeyLocation>> ApiKeyLocations { get; } = new[]
    {
        new LabeledOption<ApiKeyLocation>("Header", ApiKeyLocation.Header),
        new LabeledOption<ApiKeyLocation>("Query Param", ApiKeyLocation.Query),
    };

    public IReadOnlyList<string> RequestSections { get; } = new[]
    {
        "Params",
        "Authorization",
        "Headers",
        "Body",
        "Variables",
        "Code",
        "Scripts",
        "History",
        "Settings",
    };

    public EditableRowsViewModel Params { get; } = new();
    public EditableRowsViewModel Headers { get; } = new();
    public EditableRowsViewModel Variables { get; } = new();
    public EditableRowsViewModel BodyFields { get; } = new();
    public ObservableCollection<string> RequestHistory { get; } = new();

    public RequestEditorViewModel(
        RequestNodeViewModel node,
        RequestExecutor executor,
        RequestFileService requestFiles,
        Func<YamletRequest, VariableContext> contextFactory,
        Func<YamletRequest, RequestScriptVariables>? scriptVariablesFactory = null,
        Func<YamletAuth?>? collectionAuthFactory = null,
        Action<string>? status = null,
        bool initialSideBySide = false,
        Action<bool>? persistLayout = null,
        Func<string, string, Task>? setEnvironmentVariableAsync = null,
        Func<string?>? activeEnvironmentName = null,
        Func<(string Pre, string Post)>? collectionScriptsFactory = null)
    {
        _node = node;
        _executor = executor;
        _requestFiles = requestFiles;
        _contextFactory = contextFactory;
        _scriptVariablesFactory = scriptVariablesFactory ?? (request => RequestScriptVariables.FromContext(_contextFactory(request)));
        _collectionAuthFactory = collectionAuthFactory ?? (() => null);
        _collectionScriptsFactory = collectionScriptsFactory ?? (() => (string.Empty, string.Empty));
        _status = status;
        _persistLayout = persistLayout;
        _setEnvironmentVariableAsync = setEnvironmentVariableAsync;
        _activeEnvironmentName = activeEnvironmentName;
        _isSideBySide = initialSideBySide;

        BreadcrumbPath = BuildBreadcrumb(node);
        BreadcrumbPrefix = BuildBreadcrumbPrefix(node);
        LoadFrom(node.Request);
    }

    // ---- Editable state ----------------------------------------------------

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private string _selectedMethod = "GET";

    [ObservableProperty]
    private string _url = string.Empty;

    [ObservableProperty]
    private LabeledOption<YamletBodyType> _selectedBodyType = null!;

    [ObservableProperty]
    private string _bodyText = string.Empty;

    [ObservableProperty]
    private LabeledOption<YamletAuthType> _selectedAuthType = null!;

    [ObservableProperty]
    private string _bearerToken = string.Empty;

    [ObservableProperty]
    private string _basicUsername = string.Empty;

    [ObservableProperty]
    private string _basicPassword = string.Empty;

    [ObservableProperty]
    private string _apiKeyName = string.Empty;

    [ObservableProperty]
    private string _apiKeyValue = string.Empty;

    [ObservableProperty]
    private LabeledOption<ApiKeyLocation> _selectedApiKeyLocation = null!;

    [ObservableProperty]
    private string _cookie = string.Empty;

    [ObservableProperty]
    private string _preRequestScript = string.Empty;

    [ObservableProperty]
    private string _postResponseScript = string.Empty;

    [ObservableProperty]
    private string _codeSnippet = string.Empty;

    [ObservableProperty]
    private string _selectedRequestSection = "Params";

    public string BreadcrumbPath { get; }

    /// <summary>The collection/folder path leading to this request, without its own name.</summary>
    public string BreadcrumbPrefix { get; }

    // ---- Derived visibility flags -----------------------------------------

    public bool IsBodyEditorVisible =>
        SelectedBodyType.Value is YamletBodyType.Raw or YamletBodyType.Json;
    public bool IsBodyFieldsVisible =>
        SelectedBodyType.Value is YamletBodyType.FormData or YamletBodyType.UrlEncoded;

    public bool IsJsonBodyEditor => SelectedBodyType.Value == YamletBodyType.Json;
    public string BodyEditorLanguage => IsJsonBodyEditor ? "json" : "text";

    public bool IsBearerVisible => SelectedAuthType.Value == YamletAuthType.Bearer;
    public bool IsBasicVisible => SelectedAuthType.Value == YamletAuthType.Basic;
    public bool IsApiKeyVisible => SelectedAuthType.Value == YamletAuthType.ApiKey;
    public bool IsCookieVisible => SelectedAuthType.Value == YamletAuthType.Cookie;

    /// <summary>Tab content indicators (small dots shown next to tab headers).</summary>
    public bool HasAuth => SelectedAuthType.Value != YamletAuthType.None;
    public bool HasBody => SelectedBodyType.Value != YamletBodyType.None;
    public bool HasScripts =>
        !string.IsNullOrWhiteSpace(PreRequestScript) || !string.IsNullOrWhiteSpace(PostResponseScript);

    public bool IsParamsSection => SelectedRequestSection == "Params";
    public bool IsAuthorizationSection => SelectedRequestSection == "Authorization";
    public bool IsHeadersSection => SelectedRequestSection == "Headers";
    public bool IsBodySection => SelectedRequestSection == "Body";
    public bool IsVariablesSection => SelectedRequestSection == "Variables";
    public bool IsCodeSection => SelectedRequestSection == "Code";
    public bool IsScriptsSection => SelectedRequestSection == "Scripts";
    public bool IsHistorySection => SelectedRequestSection == "History";
    public bool IsSettingsSection => SelectedRequestSection == "Settings";

    partial void OnPreRequestScriptChanged(string value) => OnPropertyChanged(nameof(HasScripts));
    partial void OnPostResponseScriptChanged(string value) => OnPropertyChanged(nameof(HasScripts));

    partial void OnSelectedRequestSectionChanged(string value)
    {
        OnPropertyChanged(nameof(IsParamsSection));
        OnPropertyChanged(nameof(IsAuthorizationSection));
        OnPropertyChanged(nameof(IsHeadersSection));
        OnPropertyChanged(nameof(IsBodySection));
        OnPropertyChanged(nameof(IsVariablesSection));
        OnPropertyChanged(nameof(IsCodeSection));
        OnPropertyChanged(nameof(IsScriptsSection));
        OnPropertyChanged(nameof(IsHistorySection));
        OnPropertyChanged(nameof(IsSettingsSection));
    }

    partial void OnSelectedBodyTypeChanged(LabeledOption<YamletBodyType> value)
    {
        OnPropertyChanged(nameof(IsBodyEditorVisible));
        OnPropertyChanged(nameof(IsBodyFieldsVisible));
        OnPropertyChanged(nameof(IsJsonBodyEditor));
        OnPropertyChanged(nameof(BodyEditorLanguage));
        OnPropertyChanged(nameof(HasBody));
    }

    partial void OnSelectedAuthTypeChanged(LabeledOption<YamletAuthType> value)
    {
        OnPropertyChanged(nameof(IsBearerVisible));
        OnPropertyChanged(nameof(IsBasicVisible));
        OnPropertyChanged(nameof(IsApiKeyVisible));
        OnPropertyChanged(nameof(IsCookieVisible));
        OnPropertyChanged(nameof(HasAuth));
    }

    partial void OnSelectedMethodChanged(string value) => _node.Method = value;

    partial void OnNameChanged(string value) => _node.Name = value;

    // ---- Layout ------------------------------------------------------------

    /// <summary>
    /// When true the response panel sits beside the request (side-by-side columns);
    /// otherwise it is stacked below it. Persisted as a global UI preference.
    /// </summary>
    [ObservableProperty]
    private bool _isSideBySide;

    partial void OnIsSideBySideChanged(bool value)
    {
        _persistLayout?.Invoke(value);
        OnPropertyChanged(nameof(LayoutToggleTooltip));
    }

    public string LayoutToggleTooltip =>
        IsSideBySide ? "Stack response below request" : "Show response beside request";

    [RelayCommand]
    private void ToggleLayout() => IsSideBySide = !IsSideBySide;

    // ---- Variable inspection (IVariableSource) -----------------------------

    /// <summary>Raised after a variable is written, so editors re-highlight placeholders.</summary>
    public event EventHandler? VariablesChanged;

    /// <inheritdoc />
    public bool TryGetValue(string name, out string value) =>
        (_variableCache ??= _contextFactory(_node.Request)).TryGet(name, out value);

    /// <inheritdoc />
    public string TargetScopeName => _activeEnvironmentName?.Invoke() ?? "active environment";

    /// <inheritdoc />
    public async Task SetAsync(string name, string value)
    {
        if (_setEnvironmentVariableAsync is not null)
        {
            await _setEnvironmentVariableAsync(name, value).ConfigureAwait(true);
        }

        RefreshVariables();
    }

    /// <summary>
    /// Drops the cached variable context and asks editors to re-highlight. Call this when
    /// variables change <em>outside</em> this editor — e.g. the environment is edited in
    /// its own tab, or the active environment is switched — so highlight colors update
    /// without needing to reopen the tab.
    /// </summary>
    public void RefreshVariables()
    {
        _variableCache = null;
        VariablesChanged?.Invoke(this, EventArgs.Empty);
    }

    // ---- Response state ----------------------------------------------------

    [ObservableProperty]
    private bool _hasResponse;

    [ObservableProperty]
    private bool _isSending;

    [ObservableProperty]
    private string _responseStatusText = string.Empty;

    [ObservableProperty]
    private string _responseCategory = "none";

    [ObservableProperty]
    private string _responseDurationText = string.Empty;

    [ObservableProperty]
    private string _responseSizeText = string.Empty;

    [ObservableProperty]
    private string _responseBody = string.Empty;

    [ObservableProperty]
    private string _responseBodyLanguage = "text";

    [ObservableProperty]
    private bool _isResponseBodyJson;

    [ObservableProperty]
    private string _responseHeadersText = string.Empty;

    [ObservableProperty]
    private string _responseRaw = string.Empty;

    [ObservableProperty]
    private string _responseConsole = string.Empty;

    /// <summary>Condensed response area: a single dropdown chooses which view is shown.</summary>
    public IReadOnlyList<string> ResponseViews { get; } = new[] { "Body", "Headers", "Raw", "Console" };

    [ObservableProperty]
    private string _selectedResponseView = "Body";

    public bool IsResponseBodyView => SelectedResponseView == "Body";
    public bool IsResponseHeadersView => SelectedResponseView == "Headers";
    public bool IsResponseRawView => SelectedResponseView == "Raw";
    public bool IsResponseConsoleView => SelectedResponseView == "Console";

    partial void OnSelectedResponseViewChanged(string value)
    {
        OnPropertyChanged(nameof(IsResponseBodyView));
        OnPropertyChanged(nameof(IsResponseHeadersView));
        OnPropertyChanged(nameof(IsResponseRawView));
        OnPropertyChanged(nameof(IsResponseConsoleView));
    }

    // ---- Load / map --------------------------------------------------------

    private void LoadFrom(YamletRequest request)
    {
        Name = request.Name;
        SelectedMethod = Methods.Contains(request.Method.ToUpperInvariant())
            ? request.Method.ToUpperInvariant()
            : "GET";
        Url = request.Url;

        Params.Load(request.QueryParams.Select(p => new KeyValueRowViewModel
        {
            Key = p.Key, Value = p.Value, Description = p.Description, Enabled = p.Enabled,
        }));
        Headers.Load(request.Headers.Where(h => !IsDefaultHeader(h.Key)).Select(h => new KeyValueRowViewModel
        {
            Key = h.Key, Value = h.Value, Description = h.Description, Enabled = h.Enabled,
        }).Append(new KeyValueRowViewModel
        {
            Key = RequestExecutor.DefaultUserAgentHeaderName,
            Value = RequestExecutor.DefaultUserAgent,
            Description = "Default header",
            Enabled = true,
            IsReadOnly = true,
        }));
        Variables.Load(request.Variables.Select(v => new KeyValueRowViewModel
        {
            Key = v.Key, Value = v.Value, Enabled = v.Enabled,
        }));

        SelectedBodyType = BodyTypes.First(b => b.Value == request.Body.Type);
        BodyText = request.Body.Raw;
        BodyFields.Load(request.Body.Fields.Select(f => new KeyValueRowViewModel
        {
            Key = f.Key,
            Value = f.IsFile && !f.Value.StartsWith('@') ? "@" + f.Value : f.Value,
            Description = f.Description,
            Enabled = f.Enabled,
        }));

        SelectedAuthType = AuthTypes.First(a => a.Value == request.Auth.Type);
        BearerToken = request.Auth.Token;
        BasicUsername = request.Auth.Username;
        BasicPassword = request.Auth.Password;
        ApiKeyName = request.Auth.ApiKeyName;
        ApiKeyValue = request.Auth.ApiKeyValue;
        SelectedApiKeyLocation = ApiKeyLocations.First(l => l.Value == request.Auth.ApiKeyIn);
        Cookie = request.Auth.Cookie;

        PreRequestScript = request.PreRequestScript;
        PostResponseScript = request.PostResponseScript;
        RefreshCodeSnippet();
        SelectedRequestSection = BestInitialRequestSection(request);
    }

    private static string BestInitialRequestSection(YamletRequest request)
    {
        if (HasBodyContent(request.Body))
        {
            return "Body";
        }

        if (request.QueryParams.Any(HasKeyValueContent))
        {
            return "Params";
        }

        if (HasAuthContent(request.Auth))
        {
            return "Authorization";
        }

        if (request.Headers.Where(h => !IsDefaultHeader(h.Key)).Any(HasKeyValueContent))
        {
            return "Headers";
        }

        if (request.Variables.Any(v =>
                !string.IsNullOrWhiteSpace(v.Key) || !string.IsNullOrWhiteSpace(v.Value)))
        {
            return "Variables";
        }

        if (!string.IsNullOrWhiteSpace(request.PreRequestScript) ||
            !string.IsNullOrWhiteSpace(request.PostResponseScript))
        {
            return "Scripts";
        }

        return "Params";
    }

    private static bool HasBodyContent(YamletRequestBody body) =>
        body.Type switch
        {
            YamletBodyType.Raw or YamletBodyType.Json => !string.IsNullOrWhiteSpace(body.Raw),
            YamletBodyType.FormData or YamletBodyType.UrlEncoded => body.Fields.Any(HasBodyFieldContent),
            _ => false,
        };

    private static bool HasAuthContent(YamletAuth auth) =>
        auth.Type switch
        {
            YamletAuthType.Bearer => !string.IsNullOrWhiteSpace(auth.Token),
            YamletAuthType.Basic => !string.IsNullOrWhiteSpace(auth.Username) ||
                                    !string.IsNullOrWhiteSpace(auth.Password),
            YamletAuthType.ApiKey => !string.IsNullOrWhiteSpace(auth.ApiKeyName) ||
                                     !string.IsNullOrWhiteSpace(auth.ApiKeyValue),
            YamletAuthType.Cookie => !string.IsNullOrWhiteSpace(auth.Cookie),
            YamletAuthType.OAuth2 => HasOAuth2Content(auth.OAuth2),
            _ => false,
        };

    private static bool HasOAuth2Content(YamletOAuth2 oauth) =>
        !string.IsNullOrWhiteSpace(oauth.AccessToken) ||
        !string.IsNullOrWhiteSpace(oauth.RefreshToken) ||
        !string.IsNullOrWhiteSpace(oauth.AccessTokenUrl) ||
        !string.IsNullOrWhiteSpace(oauth.AuthUrl) ||
        !string.IsNullOrWhiteSpace(oauth.ClientId) ||
        !string.IsNullOrWhiteSpace(oauth.ClientSecret) ||
        !string.IsNullOrWhiteSpace(oauth.Scope) ||
        !string.IsNullOrWhiteSpace(oauth.RedirectUri) ||
        !string.IsNullOrWhiteSpace(oauth.Username) ||
        !string.IsNullOrWhiteSpace(oauth.Password);

    private static bool HasKeyValueContent(YamletQueryParam row) =>
        !string.IsNullOrWhiteSpace(row.Key) ||
        !string.IsNullOrWhiteSpace(row.Value) ||
        !string.IsNullOrWhiteSpace(row.Description);

    private static bool HasKeyValueContent(YamletHeader row) =>
        !string.IsNullOrWhiteSpace(row.Key) ||
        !string.IsNullOrWhiteSpace(row.Value) ||
        !string.IsNullOrWhiteSpace(row.Description);

    private static bool HasBodyFieldContent(YamletBodyField field) =>
        !string.IsNullOrWhiteSpace(field.Key) ||
        !string.IsNullOrWhiteSpace(field.Value) ||
        !string.IsNullOrWhiteSpace(field.Description);

    /// <summary>Writes the current editor state back into the underlying request model.</summary>
    private YamletRequest ApplyToModel()
    {
        var request = _node.Request;
        request.Name = Name;
        request.Method = SelectedMethod;
        request.Url = Url;

        request.QueryParams = Params.NonEmptyRows().Select(r => new YamletQueryParam
        {
            Key = r.Key, Value = r.Value, Description = r.Description, Enabled = r.Enabled,
        }).ToList();
        request.Headers = Headers.NonEmptyRows().Where(r => !r.IsReadOnly).Select(r => new YamletHeader
        {
            Key = r.Key, Value = r.Value, Description = r.Description, Enabled = r.Enabled,
        }).ToList();
        request.Variables = Variables.NonEmptyRows().Select(r => new YamletVariable
        {
            Key = r.Key, Value = r.Value, Enabled = r.Enabled,
        }).ToList();

        request.Body = new YamletRequestBody
        {
            Type = SelectedBodyType.Value,
            Raw = BodyText,
            Fields = BodyFields.NonEmptyRows().Select(r => new YamletBodyField
            {
                Key = r.Key,
                Value = r.Value,
                Description = r.Description,
                Enabled = r.Enabled,
                IsFile = string.Equals(r.Description.Trim(), "file", StringComparison.OrdinalIgnoreCase)
                         || r.Value.StartsWith('@'),
            }).ToList(),
        };
        request.Auth = new YamletAuth
        {
            Type = SelectedAuthType.Value,
            Token = BearerToken,
            Username = BasicUsername,
            Password = BasicPassword,
            ApiKeyName = ApiKeyName,
            ApiKeyValue = ApiKeyValue,
            ApiKeyIn = SelectedApiKeyLocation.Value,
            Cookie = Cookie,
        };
        request.PreRequestScript = PreRequestScript;
        request.PostResponseScript = PostResponseScript;
        RefreshCodeSnippet();
        return request;
    }

    private static bool IsDefaultHeader(string key) =>
        string.Equals(key, RequestExecutor.DefaultUserAgentHeaderName, StringComparison.OrdinalIgnoreCase);

    // ---- Commands ----------------------------------------------------------

    [RelayCommand]
    private async Task SaveAsync()
    {
        try
        {
            var request = ApplyToModel();
            await _requestFiles.SaveRequestAsync(request).ConfigureAwait(false);
            _status?.Invoke($"Saved {request.Name}");
        }
        catch (Exception ex)
        {
            _status?.Invoke($"Save failed: {ex.Message}");
        }
    }

    [RelayCommand]
    private void RefreshCodeSnippet() => CodeSnippet = BuildCurlSnippet();

    [RelayCommand]
    private async Task SendAsync()
    {
        if (IsSending)
        {
            return;
        }

        var request = ApplyToModel();
        if (string.IsNullOrWhiteSpace(request.Url))
        {
            _status?.Invoke("Enter a URL before sending.");
            return;
        }

        _inflight?.Cancel();
        _inflight = new CancellationTokenSource();

        IsSending = true;
        _status?.Invoke($"Sending {request.Method} {request.Url}…");
        try
        {
            var context = _contextFactory(request);
            var (collectionPre, collectionPost) = _collectionScriptsFactory();
            var response = await _executor
                .ExecuteAsync(request, context, _collectionAuthFactory(), _scriptVariablesFactory(request),
                    _inflight.Token, collectionPre, collectionPost)
                .ConfigureAwait(false);
            ApplyResponse(response);
            RequestHistory.Insert(
                0,
                response.IsError
                    ? $"{DateTime.Now:HH:mm:ss}  {request.Method} {request.Url}  Error  {response.DurationMs} ms"
                    : $"{DateTime.Now:HH:mm:ss}  {request.Method} {request.Url}  {response.StatusCode}  {response.DurationMs} ms");
            _status?.Invoke(response.IsError
                ? $"Request failed: {response.ErrorMessage}"
                : $"{response.StatusCode} {response.ReasonPhrase} · {response.DurationMs} ms");
        }
        finally
        {
            IsSending = false;
        }
    }

    private void ApplyResponse(YamletResponse response)
    {
        HasResponse = true;

        if (response.IsError)
        {
            ResponseStatusText = "Error";
            ResponseCategory = "error";
            ResponseDurationText = $"{response.DurationMs} ms";
            ResponseSizeText = "—";
            ResponseBody = response.ErrorMessage ?? "Request failed.";
            ResponseBodyLanguage = "text";
            IsResponseBodyJson = false;
            ResponseHeadersText = string.Empty;
            ResponseRaw = response.ErrorMessage ?? string.Empty;
            ResponseConsole = response.ConsoleText;
            return;
        }

        ResponseStatusText = $"{response.StatusCode} {response.ReasonPhrase}".Trim();
        ResponseCategory = CategoryFor(response.StatusCode);
        ResponseDurationText = $"{response.DurationMs} ms";
        ResponseSizeText = FormatSize(response.SizeBytes);

        var headerText = new StringBuilder();
        foreach (var header in response.Headers)
        {
            headerText.Append(header.Key).Append(": ").AppendLine(header.Value);
        }
        ResponseHeadersText = headerText.ToString().TrimEnd();

        IsResponseBodyJson = IsJsonContent(response.Body, response.ContentType);
        ResponseBodyLanguage = IsResponseBodyJson ? "json" : "text";
        ResponseBody = IsResponseBodyJson ? TryPrettyJson(response.Body) : response.Body;

        var raw = new StringBuilder();
        raw.Append("HTTP ").AppendLine(ResponseStatusText);
        raw.AppendLine(ResponseHeadersText);
        raw.AppendLine();
        raw.Append(response.Body);
        ResponseRaw = raw.ToString();
        ResponseConsole = response.ConsoleText;
    }
    private static string CategoryFor(int statusCode) => statusCode switch
    {
        >= 200 and < 300 => "success",
        >= 300 and < 400 => "redirect",
        >= 400 and < 500 => "clienterror",
        >= 500 => "servererror",
        _ => "none",
    };

    private static string FormatSize(long bytes)
    {
        if (bytes < 1024)
        {
            return $"{bytes} B";
        }
        double kb = bytes / 1024d;
        return kb < 1024 ? $"{kb:0.#} KB" : $"{kb / 1024d:0.#} MB";
    }

    private static bool IsJsonContent(string body, string contentType) =>
        !string.IsNullOrWhiteSpace(body) &&
        contentType.Contains("json", StringComparison.OrdinalIgnoreCase);

    private static string TryPrettyJson(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return body;
        }

        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            return System.Text.Json.JsonSerializer.Serialize(
                doc.RootElement,
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        }
        catch
        {
            return body;
        }
    }

    private string BuildCurlSnippet()
    {
        var sb = new StringBuilder();
        sb.Append("curl");
        sb.Append(" -X ").Append(SelectedMethod);
        sb.Append(" ").Append(ShellQuote(Url));

        foreach (var header in Headers.NonEmptyRows().Where(r => !r.IsReadOnly && r.Enabled))
        {
            sb.Append(" \\\n  -H ").Append(ShellQuote($"{header.Key}: {header.Value}"));
        }

        switch (SelectedBodyType.Value)
        {
            case YamletBodyType.Raw:
            case YamletBodyType.Json:
                if (!string.IsNullOrEmpty(BodyText))
                {
                    if (SelectedBodyType.Value == YamletBodyType.Json
                        && !Headers.NonEmptyRows().Any(h => string.Equals(h.Key, "Content-Type", StringComparison.OrdinalIgnoreCase)))
                    {
                        sb.Append(" \\\n  -H ").Append(ShellQuote("Content-Type: application/json"));
                    }
                    sb.Append(" \\\n  --data ").Append(ShellQuote(BodyText));
                }
                break;
            case YamletBodyType.UrlEncoded:
                foreach (var field in BodyFields.NonEmptyRows().Where(r => r.Enabled))
                {
                    sb.Append(" \\\n  --data-urlencode ").Append(ShellQuote($"{field.Key}={field.Value}"));
                }
                break;
            case YamletBodyType.FormData:
                foreach (var field in BodyFields.NonEmptyRows().Where(r => r.Enabled))
                {
                    var value = field.Value.StartsWith('@') ? field.Value : field.Value;
                    sb.Append(" \\\n  -F ").Append(ShellQuote($"{field.Key}={value}"));
                }
                break;
        }

        return sb.ToString();
    }

    private static string ShellQuote(string value) =>
        "'" + value.Replace("'", "'\"'\"'") + "'";

    private static string BuildBreadcrumb(TreeNodeViewModel node)
    {
        var parts = new List<string>();
        TreeNodeViewModel? current = node;
        while (current is not null)
        {
            parts.Add(current.Name);
            current = current.Parent;
        }
        parts.Reverse();
        return string.Join("  ›  ", parts);
    }

    private static string BuildBreadcrumbPrefix(TreeNodeViewModel node)
    {
        var parts = new List<string>();
        var current = node.Parent;
        while (current is not null)
        {
            parts.Add(current.Name);
            current = current.Parent;
        }
        parts.Reverse();
        return parts.Count == 0 ? string.Empty : string.Join("  ›  ", parts) + "  ›";
    }
}
