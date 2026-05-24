using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.App.ViewModels;

/// <summary>Edits settings that live on a collection metadata file.</summary>
public sealed partial class CollectionSettingsViewModel : ViewModelBase
{
    private readonly YamletCollection _collection;
    private readonly CollectionService _collectionService;
    private readonly Action<string>? _status;
    private readonly Func<YamletOAuth2, Task<string>>? _acquireToken;

    public IReadOnlyList<LabeledOption<YamletAuthType>> AuthTypes { get; } = new[]
    {
        new LabeledOption<YamletAuthType>("No Auth", YamletAuthType.None),
        new LabeledOption<YamletAuthType>("Bearer Token", YamletAuthType.Bearer),
        new LabeledOption<YamletAuthType>("OAuth 2.0", YamletAuthType.OAuth2),
        new LabeledOption<YamletAuthType>("Cookie", YamletAuthType.Cookie),
    };

    public IReadOnlyList<LabeledOption<OAuth2GrantType>> GrantTypes { get; } = new[]
    {
        new LabeledOption<OAuth2GrantType>("Client Credentials", OAuth2GrantType.ClientCredentials),
        new LabeledOption<OAuth2GrantType>("Authorization Code (browser)", OAuth2GrantType.AuthorizationCode),
        new LabeledOption<OAuth2GrantType>("Password Credentials", OAuth2GrantType.Password),
    };

    public IReadOnlyList<LabeledOption<OAuth2TokenLocation>> TokenLocations { get; } = new[]
    {
        new LabeledOption<OAuth2TokenLocation>("Request Header", OAuth2TokenLocation.Header),
        new LabeledOption<OAuth2TokenLocation>("Query Param", OAuth2TokenLocation.Query),
    };

    public IReadOnlyList<LabeledOption<OAuth2ClientAuthentication>> ClientAuthentications { get; } = new[]
    {
        new LabeledOption<OAuth2ClientAuthentication>("Send as Basic auth header", OAuth2ClientAuthentication.BasicHeader),
        new LabeledOption<OAuth2ClientAuthentication>("Send in request body", OAuth2ClientAuthentication.Body),
    };

    public CollectionSettingsViewModel(
        YamletCollection collection,
        CollectionService collectionService,
        Action<string>? status = null,
        Func<YamletOAuth2, Task<string>>? acquireToken = null)
    {
        _collection = collection;
        _collectionService = collectionService;
        _status = status;
        _acquireToken = acquireToken;

        Name = collection.Name;
        SelectedAuthType = AuthTypes.FirstOrDefault(a => a.Value == collection.Auth.Type) ?? AuthTypes[0];
        BearerToken = collection.Auth.Token;
        Cookie = collection.Auth.Cookie;

        var oauth = collection.Auth.OAuth2;
        SelectedGrantType = GrantTypes.FirstOrDefault(g => g.Value == oauth.GrantType) ?? GrantTypes[0];
        SelectedTokenLocation = TokenLocations.FirstOrDefault(t => t.Value == oauth.AddTokenTo) ?? TokenLocations[0];
        SelectedClientAuthentication = ClientAuthentications.FirstOrDefault(c => c.Value == oauth.ClientAuthentication) ?? ClientAuthentications[0];
        AccessToken = oauth.AccessToken;
        AccessTokenUrl = oauth.AccessTokenUrl;
        AuthUrl = oauth.AuthUrl;
        ClientId = oauth.ClientId;
        ClientSecret = oauth.ClientSecret;
        Scope = oauth.Scope;
        RedirectUri = oauth.RedirectUri;

        PreRequestScript = collection.PreRequestScript;
        PostResponseScript = collection.PostResponseScript;
    }

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private LabeledOption<YamletAuthType> _selectedAuthType = null!;

    [ObservableProperty]
    private string _bearerToken = string.Empty;

    [ObservableProperty]
    private string _cookie = string.Empty;

    // ---- OAuth2 ------------------------------------------------------------

    [ObservableProperty]
    private LabeledOption<OAuth2GrantType> _selectedGrantType = null!;

    [ObservableProperty]
    private LabeledOption<OAuth2TokenLocation> _selectedTokenLocation = null!;

    [ObservableProperty]
    private LabeledOption<OAuth2ClientAuthentication> _selectedClientAuthentication = null!;

    [ObservableProperty]
    private string _accessToken = string.Empty;

    [ObservableProperty]
    private string _accessTokenUrl = string.Empty;

    [ObservableProperty]
    private string _authUrl = string.Empty;

    [ObservableProperty]
    private string _clientId = string.Empty;

    [ObservableProperty]
    private string _clientSecret = string.Empty;

    [ObservableProperty]
    private string _scope = string.Empty;

    [ObservableProperty]
    private string _redirectUri = string.Empty;

    [ObservableProperty]
    private string _tokenStatus = string.Empty;

    [ObservableProperty]
    private bool _isAcquiringToken;

    // ---- Collection scripts ------------------------------------------------

    [ObservableProperty]
    private string _preRequestScript = string.Empty;

    [ObservableProperty]
    private string _postResponseScript = string.Empty;

    // ---- Derived flags -----------------------------------------------------

    public bool IsBearerVisible => SelectedAuthType.Value == YamletAuthType.Bearer;
    public bool IsCookieVisible => SelectedAuthType.Value == YamletAuthType.Cookie;
    public bool IsOAuth2Visible => SelectedAuthType.Value == YamletAuthType.OAuth2;
    public bool HasAuth => SelectedAuthType.Value != YamletAuthType.None;

    /// <summary>Authorization-code-only fields (auth URL / redirect) are shown for that grant.</summary>
    public bool IsAuthCodeGrant => SelectedGrantType.Value == OAuth2GrantType.AuthorizationCode;
    public bool HasScripts => !string.IsNullOrWhiteSpace(PreRequestScript) || !string.IsNullOrWhiteSpace(PostResponseScript);

    partial void OnSelectedAuthTypeChanged(LabeledOption<YamletAuthType> value)
    {
        OnPropertyChanged(nameof(IsBearerVisible));
        OnPropertyChanged(nameof(IsCookieVisible));
        OnPropertyChanged(nameof(IsOAuth2Visible));
        OnPropertyChanged(nameof(HasAuth));
    }

    partial void OnSelectedGrantTypeChanged(LabeledOption<OAuth2GrantType> value) =>
        OnPropertyChanged(nameof(IsAuthCodeGrant));

    partial void OnPreRequestScriptChanged(string value) => OnPropertyChanged(nameof(HasScripts));
    partial void OnPostResponseScriptChanged(string value) => OnPropertyChanged(nameof(HasScripts));

    private YamletOAuth2 BuildOAuth2() => new()
    {
        GrantType = SelectedGrantType.Value,
        AddTokenTo = SelectedTokenLocation.Value,
        ClientAuthentication = SelectedClientAuthentication.Value,
        AccessToken = AccessToken,
        AccessTokenUrl = AccessTokenUrl,
        AuthUrl = AuthUrl,
        ClientId = ClientId,
        ClientSecret = ClientSecret,
        Scope = Scope,
        RedirectUri = RedirectUri,
        HeaderPrefix = _collection.Auth.OAuth2.HeaderPrefix,
        ChallengeAlgorithm = _collection.Auth.OAuth2.ChallengeAlgorithm,
    };

    [RelayCommand]
    private async Task GetTokenAsync()
    {
        if (_acquireToken is null || IsAcquiringToken)
        {
            return;
        }

        IsAcquiringToken = true;
        TokenStatus = "Requesting token…";
        try
        {
            var token = await _acquireToken(BuildOAuth2()).ConfigureAwait(true);
            if (!string.IsNullOrWhiteSpace(token))
            {
                AccessToken = token;
                TokenStatus = "Access token acquired.";
            }
            else
            {
                TokenStatus = "No access token returned.";
            }
        }
        catch (Exception ex)
        {
            TokenStatus = $"Token request failed: {ex.Message}";
        }
        finally
        {
            IsAcquiringToken = false;
        }
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        _collection.Name = Name;
        _collection.Auth = new YamletAuth
        {
            Type = SelectedAuthType.Value,
            Token = BearerToken,
            Cookie = Cookie,
            OAuth2 = BuildOAuth2(),
        };
        _collection.PreRequestScript = PreRequestScript;
        _collection.PostResponseScript = PostResponseScript;

        try
        {
            await _collectionService.SaveCollectionAsync(_collection);
            _status?.Invoke($"Saved {Name}");
        }
        catch (Exception ex)
        {
            _status?.Invoke($"Save failed: {ex.Message}");
        }
    }
}
