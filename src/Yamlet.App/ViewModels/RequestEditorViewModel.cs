using System.Text;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.App.ViewModels;

/// <summary>
/// Edits a single request and runs it. Holds observable copies of the request's
/// fields, maps them back to the <see cref="YamletRequest"/> model on save/send, and
/// surfaces the resulting <see cref="YamletResponse"/>.
/// </summary>
public sealed partial class RequestEditorViewModel : ViewModelBase
{
    private readonly RequestExecutor _executor;
    private readonly RequestFileService _requestFiles;
    private readonly Func<YamletRequest, VariableContext> _contextFactory;
    private readonly Func<YamletRequest, RequestScriptVariables> _scriptVariablesFactory;
    private readonly Func<YamletAuth?> _collectionAuthFactory;
    private readonly Action<string>? _status;
    private readonly Action<bool>? _persistLayout;
    private readonly RequestNodeViewModel _node;
    private CancellationTokenSource? _inflight;

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

    public EditableRowsViewModel Params { get; } = new();
    public EditableRowsViewModel Headers { get; } = new();
    public EditableRowsViewModel Variables { get; } = new();

    public RequestEditorViewModel(
        RequestNodeViewModel node,
        RequestExecutor executor,
        RequestFileService requestFiles,
        Func<YamletRequest, VariableContext> contextFactory,
        Func<YamletRequest, RequestScriptVariables>? scriptVariablesFactory = null,
        Func<YamletAuth?>? collectionAuthFactory = null,
        Action<string>? status = null,
        bool initialSideBySide = false,
        Action<bool>? persistLayout = null)
    {
        _node = node;
        _executor = executor;
        _requestFiles = requestFiles;
        _contextFactory = contextFactory;
        _scriptVariablesFactory = scriptVariablesFactory ?? (request => RequestScriptVariables.FromContext(_contextFactory(request)));
        _collectionAuthFactory = collectionAuthFactory ?? (() => null);
        _status = status;
        _persistLayout = persistLayout;
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

    public string BreadcrumbPath { get; }

    /// <summary>The collection/folder path leading to this request, without its own name.</summary>
    public string BreadcrumbPrefix { get; }

    // ---- Derived visibility flags -----------------------------------------

    public bool IsBodyEditorVisible =>
        SelectedBodyType.Value is YamletBodyType.Raw or YamletBodyType.Json;

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

    partial void OnPreRequestScriptChanged(string value) => OnPropertyChanged(nameof(HasScripts));
    partial void OnPostResponseScriptChanged(string value) => OnPropertyChanged(nameof(HasScripts));

    partial void OnSelectedBodyTypeChanged(LabeledOption<YamletBodyType> value)
    {
        OnPropertyChanged(nameof(IsBodyEditorVisible));
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
    }

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

        request.Body = new YamletRequestBody { Type = SelectedBodyType.Value, Raw = BodyText };
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
            var response = await _executor
                .ExecuteAsync(request, context, _collectionAuthFactory(), _scriptVariablesFactory(request), _inflight.Token)
                .ConfigureAwait(false);
            ApplyResponse(response);
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
