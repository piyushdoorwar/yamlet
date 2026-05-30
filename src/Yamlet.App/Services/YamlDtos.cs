using YamlDotNet.Serialization;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

// These DTOs define the exact on-disk YAML shape. They are deliberately separate from
// the domain models in Yamlet.App.Models so the file format and the UI can evolve
// independently. Each carries mapping helpers to/from its domain counterpart.

public sealed class KeyValueDto
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
    public string? Description { get; set; }

    /// <summary>Yamlet's native flag (defaults to enabled when absent).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Alternate flag used by exported files; inverts <see cref="Enabled"/> when present.</summary>
    public bool? Disabled { get; set; }

    /// <summary>Effective enabled state, honoring whichever flag the file used.</summary>
    public bool IsEnabled => Disabled.HasValue ? !Disabled.Value : Enabled;
}

public sealed class AuthDto
{
    public string Type { get; set; } = "noauth";
    public string? Token { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string? Key { get; set; }
    public string? Value { get; set; }
    public string? In { get; set; }
    public string? Cookie { get; set; }

    /// <summary>OAuth2 settings, written under <c>credentials:</c> (as exported files do).</summary>
    public OAuth2CredentialsDto? Credentials { get; set; }

    public static AuthDto FromDomain(YamletAuth a) => new()
    {
        Type = a.Type switch
        {
            YamletAuthType.Bearer => "bearer",
            YamletAuthType.Basic => "basic",
            YamletAuthType.ApiKey => "apikey",
            YamletAuthType.Cookie => "cookie",
            YamletAuthType.OAuth2 => "oauth2",
            _ => "noauth",
        },
        Token = NullIfEmpty(a.Token),
        Username = NullIfEmpty(a.Username),
        Password = NullIfEmpty(a.Password),
        Key = NullIfEmpty(a.ApiKeyName),
        Value = NullIfEmpty(a.ApiKeyValue),
        Cookie = NullIfEmpty(a.Cookie),
        In = a.Type == YamletAuthType.ApiKey
            ? (a.ApiKeyIn == ApiKeyLocation.Query ? "query" : "header")
            : null,
        Credentials = a.Type == YamletAuthType.OAuth2 ? OAuth2CredentialsDto.FromDomain(a.OAuth2) : null,
    };

    public YamletAuth ToDomain() => new()
    {
        Type = (Type ?? "none").ToLowerInvariant() switch
        {
            "bearer" => YamletAuthType.Bearer,
            "basic" => YamletAuthType.Basic,
            "apikey" => YamletAuthType.ApiKey,
            "api-key" => YamletAuthType.ApiKey,
            "cookie" => YamletAuthType.Cookie,
            "oauth2" => YamletAuthType.OAuth2,
            "inherit" => YamletAuthType.Inherit,
            "inherited" => YamletAuthType.Inherit,
            "noauth" => YamletAuthType.None,
            "none" => YamletAuthType.None,
            _ => YamletAuthType.None,
        },
        Token = Token ?? string.Empty,
        Username = Username ?? string.Empty,
        Password = Password ?? string.Empty,
        ApiKeyName = Key ?? string.Empty,
        ApiKeyValue = Value ?? string.Empty,
        Cookie = Cookie ?? string.Empty,
        ApiKeyIn = string.Equals(In, "query", StringComparison.OrdinalIgnoreCase)
            ? ApiKeyLocation.Query
            : ApiKeyLocation.Header,
        OAuth2 = Credentials?.ToDomain() ?? new YamletOAuth2(),
    };

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
}

/// <summary>
/// On-disk shape of an OAuth2 <c>credentials</c> block. Mixes camelCase and snake_case
/// keys (as exported files do), so snake_case fields carry explicit aliases.
/// </summary>
public sealed class OAuth2CredentialsDto
{
    public string? TokenType { get; set; }
    public string? AccessToken { get; set; }
    public string? RefreshToken { get; set; }
    public string? AccessTokenUrl { get; set; }
    public string? AuthUrl { get; set; }
    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? Scope { get; set; }
    public string? TokenName { get; set; }
    public string? ChallengeAlgorithm { get; set; }
    public string? AddTokenTo { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }

    [YamlMember(Alias = "grant_type")]
    public string? GrantType { get; set; }

    [YamlMember(Alias = "redirect_uri")]
    public string? RedirectUri { get; set; }

    [YamlMember(Alias = "client_authentication")]
    public string? ClientAuthentication { get; set; }

    public static OAuth2CredentialsDto FromDomain(YamletOAuth2 o) => new()
    {
        TokenType = NullIfEmpty(o.HeaderPrefix),
        AccessToken = NullIfEmpty(o.AccessToken),
        RefreshToken = NullIfEmpty(o.RefreshToken),
        AccessTokenUrl = NullIfEmpty(o.AccessTokenUrl),
        AuthUrl = NullIfEmpty(o.AuthUrl),
        ClientId = NullIfEmpty(o.ClientId),
        ClientSecret = NullIfEmpty(o.ClientSecret),
        Scope = NullIfEmpty(o.Scope),
        ChallengeAlgorithm = NullIfEmpty(o.ChallengeAlgorithm),
        Username = NullIfEmpty(o.Username),
        Password = NullIfEmpty(o.Password),
        AddTokenTo = o.AddTokenTo == OAuth2TokenLocation.Query ? "queryParams" : "header",
        ClientAuthentication = o.ClientAuthentication == OAuth2ClientAuthentication.Body ? "body" : "header",
        GrantType = o.GrantType switch
        {
            OAuth2GrantType.AuthorizationCode => "authorization_code",
            OAuth2GrantType.Password => "password_credentials",
            _ => "client_credentials",
        },
        RedirectUri = NullIfEmpty(o.RedirectUri),
    };

    public YamletOAuth2 ToDomain() => new()
    {
        GrantType = (GrantType ?? "client_credentials").ToLowerInvariant() switch
        {
            "authorization_code" => OAuth2GrantType.AuthorizationCode,
            "password_credentials" => OAuth2GrantType.Password,
            "password" => OAuth2GrantType.Password,
            _ => OAuth2GrantType.ClientCredentials,
        },
        AccessToken = AccessToken ?? string.Empty,
        RefreshToken = RefreshToken ?? string.Empty,
        HeaderPrefix = string.IsNullOrWhiteSpace(TokenType) ? "Bearer" : TokenType!,
        AccessTokenUrl = AccessTokenUrl ?? string.Empty,
        AuthUrl = AuthUrl ?? string.Empty,
        ClientId = ClientId ?? string.Empty,
        ClientSecret = ClientSecret ?? string.Empty,
        Scope = Scope ?? string.Empty,
        RedirectUri = RedirectUri ?? string.Empty,
        Username = Username ?? string.Empty,
        Password = Password ?? string.Empty,
        AddTokenTo = string.Equals(AddTokenTo, "queryParams", StringComparison.OrdinalIgnoreCase)
                     || string.Equals(AddTokenTo, "query", StringComparison.OrdinalIgnoreCase)
            ? OAuth2TokenLocation.Query
            : OAuth2TokenLocation.Header,
        ClientAuthentication = string.Equals(ClientAuthentication, "body", StringComparison.OrdinalIgnoreCase)
            ? OAuth2ClientAuthentication.Body
            : OAuth2ClientAuthentication.BasicHeader,
        ChallengeAlgorithm = string.IsNullOrWhiteSpace(ChallengeAlgorithm) ? "S256" : ChallengeAlgorithm!,
    };

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
}

public sealed class BodyDto
{
    public string Type { get; set; } = "none";
    public string? Raw { get; set; }

    /// <summary>
    /// Alternate payload key used by exported files. For raw/JSON bodies this is the
    /// string payload (alias for <see cref="Raw"/>); for <c>form-data</c> /
    /// <c>x-www-form-urlencoded</c> bodies it is a list of field entries. Typed as
    /// <see cref="object"/> so both scalar and list shapes deserialize.
    /// </summary>
    public object? Content { get; set; }

    public static BodyDto FromDomain(YamletRequestBody b) => new()
    {
        Type = b.Type switch
        {
            YamletBodyType.Raw => "raw",
            YamletBodyType.Json => "json",
            YamletBodyType.FormData => "form-data",
            YamletBodyType.UrlEncoded => "x-www-form-urlencoded",
            _ => "none",
        },
        Raw = b.Type is YamletBodyType.FormData or YamletBodyType.UrlEncoded
            ? null
            : string.IsNullOrEmpty(b.Raw) ? null : b.Raw,
        Content = b.Type is YamletBodyType.FormData or YamletBodyType.UrlEncoded
            ? b.Fields.Where(f => !string.IsNullOrWhiteSpace(f.Key)).Select(FormFieldDto.FromDomain).ToList()
            : null,
    };

    public YamletRequestBody ToDomain() => new()
    {
        Type = (Type ?? "none").ToLowerInvariant() switch
        {
            "raw" => YamletBodyType.Raw,
            "json" => YamletBodyType.Json,
            "form-data" => YamletBodyType.FormData,
            "formdata" => YamletBodyType.FormData,
            "x-www-form-urlencoded" => YamletBodyType.UrlEncoded,
            "urlencoded" => YamletBodyType.UrlEncoded,
            "text" => YamletBodyType.Raw,
            "xml" => YamletBodyType.Raw,
            _ => YamletBodyType.None,
        },
        Raw = Raw ?? (Content as string) ?? string.Empty,
        Fields = ParseFields(Content),
    };

    private static List<YamletBodyField> ParseFields(object? raw)
    {
        var result = new List<YamletBodyField>();
        if (raw is not System.Collections.IEnumerable list || raw is string)
        {
            return result;
        }

        foreach (var item in list)
        {
            if (item is IDictionary<object, object> map)
            {
                result.Add(FormFieldDto.FromMap(map).ToDomain());
            }
        }

        return result;
    }
}

public sealed class FormFieldDto
{
    public string Type { get; set; } = "text";
    public string Key { get; set; } = string.Empty;
    public string? Value { get; set; }
    public string? Description { get; set; }
    public bool Enabled { get; set; } = true;
    public bool? Disabled { get; set; }

    /// <summary>File paths from imported form-data bodies.</summary>
    public object? Src { get; set; }

    public bool IsEnabled => Disabled.HasValue ? !Disabled.Value : Enabled;

    public static FormFieldDto FromDomain(YamletBodyField f) => new()
    {
        Type = f.IsFile ? "file" : "text",
        Key = f.Key,
        Value = f.IsFile ? null : NullIfEmpty(f.Value),
        Description = NullIfEmpty(f.Description),
        Enabled = f.Enabled,
        Src = f.IsFile ? new[] { TrimFilePrefix(f.Value) } : null,
    };

    public YamletBodyField ToDomain() => new()
    {
        Key = Key,
        Value = string.Equals(Type, "file", StringComparison.OrdinalIgnoreCase)
            ? FirstSrc(Src)
            : Value ?? string.Empty,
        Description = Description ?? (string.Equals(Type, "file", StringComparison.OrdinalIgnoreCase) ? "file" : string.Empty),
        Enabled = IsEnabled,
        IsFile = string.Equals(Type, "file", StringComparison.OrdinalIgnoreCase),
    };

    public static FormFieldDto FromMap(IDictionary<object, object> map) => new()
    {
        Type = Lookup(map, "type", "text"),
        Key = Lookup(map, "key"),
        Value = Lookup(map, "value"),
        Description = Lookup(map, "description"),
        Enabled = !string.Equals(Lookup(map, "enabled"), "false", StringComparison.OrdinalIgnoreCase),
        Disabled = bool.TryParse(Lookup(map, "disabled"), out var disabled) ? disabled : null,
        Src = map.TryGetValue("src", out var src) ? src : null,
    };

    private static string FirstSrc(object? src)
    {
        if (src is System.Collections.IEnumerable list and not string)
        {
            foreach (var item in list)
            {
                return item?.ToString() ?? string.Empty;
            }
        }

        return src?.ToString() ?? string.Empty;
    }

    private static string Lookup(IDictionary<object, object> map, string key, string fallback = "") =>
        map.TryGetValue(key, out var value) ? value?.ToString() ?? fallback : fallback;

    private static string TrimFilePrefix(string value) =>
        value.StartsWith('@') ? value[1..] : value;

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
}

/// <summary>
/// A pre-request or post-response script entry, e.g. <c>{ type: afterResponse, code: ... }</c>.
/// The <c>type</c> is recognised loosely so both Yamlet (<c>preRequest</c>/<c>afterResponse</c>)
/// and exported (<c>http:beforeRequest</c>/<c>http:afterResponse</c>) forms work.
/// </summary>
public sealed class ScriptDto
{
    public string Type { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;

    public static bool IsPreType(string? type)
    {
        var t = (type ?? string.Empty).ToLowerInvariant().Replace("-", string.Empty);
        return t.Contains("pre") || t.Contains("before");
    }

    /// <summary>Joins the code of all entries matching the requested phase.</summary>
    public static string JoinByPhase(IEnumerable<ScriptDto>? scripts, bool isPre)
    {
        if (scripts is null)
        {
            return string.Empty;
        }

        return string.Join("\n\n", scripts
            .Where(s => IsPreType(s.Type) == isPre && !string.IsNullOrEmpty(s.Code))
            .Select(s => s.Code));
    }

    /// <summary>Builds the script list to persist from a pre/post code pair.</summary>
    public static List<ScriptDto>? Build(string pre, string post)
    {
        var list = new List<ScriptDto>();
        if (!string.IsNullOrEmpty(pre))
        {
            list.Add(new ScriptDto { Type = "preRequest", Code = pre });
        }
        if (!string.IsNullOrEmpty(post))
        {
            list.Add(new ScriptDto { Type = "afterResponse", Code = post });
        }
        return list.Count == 0 ? null : list;
    }
}

/// <summary>On-disk shape of a single request YAML file.</summary>
public sealed class RequestDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }

    /// <summary>Position among sibling requests in the same directory (lower sorts first).</summary>
    public int? Order { get; set; }
    public string Method { get; set; } = "GET";
    public string Url { get; set; } = string.Empty;
    public List<KeyValueDto>? QueryParams { get; set; }
    public List<ScriptDto>? Scripts { get; set; }

    /// <summary>
    /// Headers may be a list (Yamlet's native form) or a map of name→value (as written
    /// by some exported files). Typed as <see cref="object"/> so both deserialize, then
    /// normalized by <see cref="ParseHeaders"/>.
    /// </summary>
    public object? Headers { get; set; }
    public List<KeyValueDto>? PathVariables { get; set; }
    public List<KeyValueDto>? Variables { get; set; }
    public AuthDto? Auth { get; set; }
    public BodyDto? Body { get; set; }
    public bool? SkipSslVerification { get; set; }

    public static RequestDto FromDomain(YamletRequest r) => new()
    {
        Id = r.Id,
        Name = r.Name,
        Description = NullIfEmpty(r.Description),
        Order = r.Order,
        Method = r.Method,
        Url = r.Url,
        Scripts = BuildScripts(r),
        QueryParams = r.QueryParams.Count == 0 ? null : r.QueryParams
            .Select(p => new KeyValueDto { Key = p.Key, Value = p.Value, Description = NullIfEmpty(p.Description), Enabled = p.Enabled })
            .ToList(),
        Headers = r.Headers.Count == 0 ? null : r.Headers
            .Select(h => new KeyValueDto { Key = h.Key, Value = h.Value, Description = NullIfEmpty(h.Description), Enabled = h.Enabled })
            .ToList<KeyValueDto>(),
        PathVariables = r.PathVariables.Count == 0 ? null : r.PathVariables
            .Select(p => new KeyValueDto { Key = p.Key, Value = p.Value, Description = NullIfEmpty(p.Description), Enabled = true })
            .ToList(),
        Variables = r.Variables.Count == 0 ? null : r.Variables
            .Select(v => new KeyValueDto { Key = v.Key, Value = v.Value, Enabled = v.Enabled })
            .ToList(),
        Auth = r.Auth.Type == YamletAuthType.Inherit ? null : AuthDto.FromDomain(r.Auth),
        Body = BodyDto.FromDomain(r.Body),
        SkipSslVerification = r.SkipSslVerification ? true : null,
    };

    public YamletRequest ToDomain(string? sourceFilePath) => new()
    {
        Id = string.IsNullOrWhiteSpace(Id) ? Guid.NewGuid().ToString() : Id,
        Name = Name,
        Description = Description ?? string.Empty,
        Order = Order ?? 0,
        Method = string.IsNullOrWhiteSpace(Method) ? "GET" : Method.ToUpperInvariant(),
        Url = Url,
        PreRequestScript = ScriptOfKind(isPre: true),
        PostResponseScript = ScriptOfKind(isPre: false),
        QueryParams = (QueryParams ?? new()).Select(p => new YamletQueryParam
        {
            Key = p.Key, Value = p.Value, Description = p.Description ?? string.Empty, Enabled = p.IsEnabled,
        }).ToList(),
        Headers = ParseHeaders(Headers),
        PathVariables = (PathVariables ?? new()).Select(p => new YamletPathVariable
        {
            Key = p.Key, Value = p.Value, Description = p.Description ?? string.Empty,
        }).ToList(),
        Variables = (Variables ?? new()).Select(v => new YamletVariable
        {
            Key = v.Key, Value = v.Value, Enabled = v.IsEnabled,
        }).ToList(),
        Auth = Auth is null ? new YamletAuth { Type = YamletAuthType.Inherit } : Auth.ToDomain(),
        Body = (Body ?? new BodyDto()).ToDomain(),
        SkipSslVerification = SkipSslVerification ?? false,
        SourceFilePath = sourceFilePath,
    };

    /// <summary>
    /// Normalizes the loosely-typed <c>headers</c> node into header models. Accepts both
    /// a list of key/value entries and a name→value map.
    /// </summary>
    private static List<YamletHeader> ParseHeaders(object? raw)
    {
        var result = new List<YamletHeader>();

        switch (raw)
        {
            case IDictionary<object, object> map:
                foreach (var entry in map)
                {
                    result.Add(new YamletHeader
                    {
                        Key = entry.Key?.ToString() ?? string.Empty,
                        Value = entry.Value?.ToString() ?? string.Empty,
                        Enabled = true,
                    });
                }
                break;

            case System.Collections.IEnumerable list and not string:
                foreach (var item in list)
                {
                    if (item is IDictionary<object, object> entry)
                    {
                        result.Add(new YamletHeader
                        {
                            Key = Lookup(entry, "key"),
                            Value = Lookup(entry, "value"),
                            Description = Lookup(entry, "description"),
                            Enabled = !string.Equals(Lookup(entry, "disabled"), "true", StringComparison.OrdinalIgnoreCase)
                                      && !string.Equals(Lookup(entry, "enabled"), "false", StringComparison.OrdinalIgnoreCase),
                        });
                    }
                }
                break;
        }

        return result;
    }

    private static string Lookup(IDictionary<object, object> map, string key) =>
        map.TryGetValue(key, out var value) ? value?.ToString() ?? string.Empty : string.Empty;

    private string ScriptOfKind(bool isPre) => ScriptDto.JoinByPhase(Scripts, isPre);

    private static List<ScriptDto>? BuildScripts(YamletRequest r) =>
        ScriptDto.Build(r.PreRequestScript, r.PostResponseScript);

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
}

/// <summary>On-disk shape of a <c>collection.yaml</c> metadata file.</summary>
public sealed class CollectionDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;

    /// <summary>Position among sibling collections (lower sorts first).</summary>
    public int? Order { get; set; }
    public List<KeyValueDto>? Variables { get; set; }
    public AuthDto? Auth { get; set; }
    public List<ScriptDto>? Scripts { get; set; }

    public static CollectionDto FromDomain(YamletCollection c) => new()
    {
        Id = c.Id,
        Name = c.Name,
        Order = c.Order,
        Auth = c.Auth.Type == YamletAuthType.None ? null : AuthDto.FromDomain(c.Auth),
        Variables = c.Variables.Count == 0 ? null : c.Variables
            .Select(v => new KeyValueDto { Key = v.Key, Value = v.Value, Enabled = v.Enabled })
            .ToList(),
        Scripts = ScriptDto.Build(c.PreRequestScript, c.PostResponseScript),
    };

    /// <summary>
    /// Applies this metadata onto a collection. Merge-friendly: only fields actually
    /// present override what's already there, so a <c>collection.yaml</c> can sit
    /// alongside an exported <c>.resources/definition.yaml</c> without wiping it.
    /// </summary>
    public void ApplyTo(YamletCollection c)
    {
        if (!string.IsNullOrWhiteSpace(Id))
        {
            c.Id = Id;
        }
        if (!string.IsNullOrWhiteSpace(Name))
        {
            c.Name = Name;
        }
        if (Order.HasValue)
        {
            c.Order = Order.Value;
        }
        if (Auth is not null)
        {
            c.Auth = Auth.ToDomain();
        }
        if (Variables is { Count: > 0 })
        {
            c.Variables = Variables.Select(v => new YamletVariable
            {
                Key = v.Key, Value = v.Value, Enabled = v.IsEnabled,
            }).ToList();
        }

        var pre = ScriptDto.JoinByPhase(Scripts, isPre: true);
        var post = ScriptDto.JoinByPhase(Scripts, isPre: false);
        if (!string.IsNullOrEmpty(pre))
        {
            c.PreRequestScript = pre;
        }
        if (!string.IsNullOrEmpty(post))
        {
            c.PostResponseScript = post;
        }
    }
}

/// <summary>
/// On-disk shape of a folder's <c>folder.yaml</c> metadata file. Carries the folder's
/// display name and its position among sibling folders so the tree order survives reloads.
/// </summary>
public sealed class FolderDto
{
    public string? Name { get; set; }

    /// <summary>Position among sibling folders in the same directory (lower sorts first).</summary>
    public int? Order { get; set; }

    public static FolderDto FromDomain(YamletFolder f) => new()
    {
        Name = f.Name,
        Order = f.Order,
    };

    /// <summary>Applies the file's metadata onto a folder, keeping the directory-derived name when absent.</summary>
    public void ApplyTo(YamletFolder f)
    {
        if (!string.IsNullOrWhiteSpace(Name))
        {
            f.Name = Name;
        }
        if (Order.HasValue)
        {
            f.Order = Order.Value;
        }
    }
}

/// <summary>
/// On-disk shape of an exported collection's <c>.resources/definition.yaml</c>: a
/// collection's variables (as a name→value map), auth (as a list of schemes), and
/// collection-scope scripts. Read as a metadata source for collections that lack a
/// native <c>collection.yaml</c> (or to supply collection-level scripts).
/// </summary>
public sealed class CollectionDefinitionDto
{
    public string? Name { get; set; }
    public Dictionary<string, string>? Variables { get; set; }
    public List<AuthDto>? Auth { get; set; }
    public List<ScriptDto>? Scripts { get; set; }

    public void ApplyTo(YamletCollection c)
    {
        if (!string.IsNullOrWhiteSpace(Name))
        {
            c.Name = Name;
        }
        if (Variables is { Count: > 0 })
        {
            c.Variables = Variables.Select(kv => new YamletVariable
            {
                Key = kv.Key, Value = kv.Value ?? string.Empty, Enabled = true,
            }).ToList();
        }

        var auth = Auth?.FirstOrDefault();
        if (auth is not null)
        {
            c.Auth = auth.ToDomain();
        }

        var pre = ScriptDto.JoinByPhase(Scripts, isPre: true);
        var post = ScriptDto.JoinByPhase(Scripts, isPre: false);
        if (!string.IsNullOrEmpty(pre))
        {
            c.PreRequestScript = pre;
        }
        if (!string.IsNullOrEmpty(post))
        {
            c.PostResponseScript = post;
        }
    }
}

/// <summary>On-disk shape of an environment YAML file.</summary>
public sealed class EnvironmentDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;
    public List<KeyValueDto>? Variables { get; set; }

    /// <summary>Alternate key used by exported files (alias for <see cref="Variables"/>).</summary>
    public List<KeyValueDto>? Values { get; set; }

    public static EnvironmentDto FromDomain(YamletEnvironment e) => new()
    {
        Id = e.Id,
        Name = e.Name,
        Variables = e.Variables.Count == 0 ? null : e.Variables
            .Select(v => new KeyValueDto { Key = v.Key, Value = v.Value, Enabled = v.Enabled })
            .ToList(),
    };

    public YamletEnvironment ToDomain(string? filePath) => new()
    {
        Id = string.IsNullOrWhiteSpace(Id) ? Guid.NewGuid().ToString() : Id,
        Name = Name,
        Variables = (Variables ?? Values ?? new()).Select(v => new YamletVariable
        {
            Key = v.Key, Value = v.Value, Enabled = v.IsEnabled,
        }).ToList(),
        FilePath = filePath,
    };
}

/// <summary>On-disk shape of <c>globals/globals.yaml</c>.</summary>
public sealed class GlobalsDto
{
    public List<KeyValueDto>? Variables { get; set; }

    public static GlobalsDto FromDomain(IEnumerable<YamletVariable> vars)
    {
        var list = vars.ToList();
        return new GlobalsDto
        {
            Variables = list.Count == 0 ? null : list
                .Select(v => new KeyValueDto { Key = v.Key, Value = v.Value, Enabled = v.Enabled })
                .ToList(),
        };
    }

    public List<YamletVariable> ToDomain() =>
        (Variables ?? new()).Select(v => new YamletVariable
        {
            Key = v.Key, Value = v.Value, Enabled = v.IsEnabled,
        }).ToList();
}

// ---- Postman Collection v2.1 Format DTOs ----------------------------------------
// Used to write collection.yaml in a format the Postman CLI can process, while still
// carrying extra Yamlet-specific fields that Postman ignores.

/// <summary>
/// A single key/value/type entry inside a Postman auth credential list, e.g.
/// <c>bearer: [{key: token, value: "...", type: string}]</c>.
/// </summary>
public sealed class PostmanAuthKvDto
{
    public string Key { get; set; } = string.Empty;
    public string? Value { get; set; }
    public string? Type { get; set; }
}

/// <summary>
/// Postman auth block. Each auth type stores its credentials as a named list of
/// <see cref="PostmanAuthKvDto"/> entries. Also carries the flat Yamlet-native fields
/// (<c>token</c>, <c>username</c>, …) so the same class can round-trip both formats.
/// </summary>
public sealed class PostmanAuthDto
{
    public string Type { get; set; } = "noauth";

    // Postman list format (one list per auth type)
    public List<PostmanAuthKvDto>? Bearer { get; set; }
    public List<PostmanAuthKvDto>? Basic { get; set; }
    public List<PostmanAuthKvDto>? Apikey { get; set; }
    public List<PostmanAuthKvDto>? Oauth2 { get; set; }

    // Old Yamlet flat-format fallback (present in files written before this change)
    public string? Token { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string? Key { get; set; }
    public string? Value { get; set; }
    public string? In { get; set; }
    public string? Cookie { get; set; }
    public OAuth2CredentialsDto? Credentials { get; set; }

    public static PostmanAuthDto? FromDomain(YamletAuth auth)
    {
        return auth.Type switch
        {
            YamletAuthType.None => new() { Type = "noauth" },
            YamletAuthType.Inherit => null,
            YamletAuthType.Bearer => new()
            {
                Type = "bearer",
                Bearer = [new() { Key = "token", Value = auth.Token, Type = "string" }],
            },
            YamletAuthType.Basic => new()
            {
                Type = "basic",
                Basic =
                [
                    new() { Key = "username", Value = auth.Username, Type = "string" },
                    new() { Key = "password", Value = auth.Password, Type = "string" },
                ],
            },
            YamletAuthType.ApiKey => new()
            {
                Type = "apikey",
                Apikey =
                [
                    new() { Key = "key", Value = auth.ApiKeyName, Type = "string" },
                    new() { Key = "value", Value = auth.ApiKeyValue, Type = "string" },
                    new() { Key = "in", Value = auth.ApiKeyIn == ApiKeyLocation.Query ? "query" : "header", Type = "string" },
                ],
            },
            YamletAuthType.Cookie => new() { Type = "noauth" },
            YamletAuthType.OAuth2 => BuildOAuth2Auth(auth.OAuth2),
            _ => new() { Type = "noauth" },
        };
    }

    private static PostmanAuthDto BuildOAuth2Auth(YamletOAuth2 o) => new()
    {
        Type = "oauth2",
        Oauth2 =
        [
            new() { Key = "accessToken", Value = o.AccessToken, Type = "string" },
            new() { Key = "tokenType", Value = o.HeaderPrefix, Type = "string" },
            new() { Key = "addTokenTo", Value = o.AddTokenTo == OAuth2TokenLocation.Query ? "queryParams" : "header", Type = "string" },
            new() { Key = "accessTokenUrl", Value = o.AccessTokenUrl, Type = "string" },
            new() { Key = "authUrl", Value = o.AuthUrl, Type = "string" },
            new() { Key = "clientId", Value = o.ClientId, Type = "string" },
            new() { Key = "clientSecret", Value = o.ClientSecret, Type = "string" },
            new() { Key = "scope", Value = o.Scope, Type = "string" },
            new() { Key = "redirectUri", Value = o.RedirectUri, Type = "string" },
            new() { Key = "grant_type", Value = o.GrantType switch
            {
                OAuth2GrantType.AuthorizationCode => "authorization_code",
                OAuth2GrantType.Password => "password_credentials",
                _ => "client_credentials",
            }, Type = "string" },
            new() { Key = "client_authentication", Value = o.ClientAuthentication == OAuth2ClientAuthentication.Body ? "body" : "header", Type = "string" },
        ],
    };

    public YamletAuth ToDomain()
    {
        var type = (Type ?? "noauth").ToLowerInvariant() switch
        {
            "bearer" => YamletAuthType.Bearer,
            "basic" => YamletAuthType.Basic,
            "apikey" or "api-key" => YamletAuthType.ApiKey,
            "oauth2" => YamletAuthType.OAuth2,
            "cookie" => YamletAuthType.Cookie,
            "inherit" or "inherited" => YamletAuthType.Inherit,
            _ => YamletAuthType.None,
        };

        return type switch
        {
            YamletAuthType.Bearer => new()
            {
                Type = YamletAuthType.Bearer,
                Token = LookupKv(Bearer, "token") ?? Token ?? string.Empty,
            },
            YamletAuthType.Basic => new()
            {
                Type = YamletAuthType.Basic,
                Username = LookupKv(Basic, "username") ?? Username ?? string.Empty,
                Password = LookupKv(Basic, "password") ?? Password ?? string.Empty,
            },
            YamletAuthType.ApiKey => new()
            {
                Type = YamletAuthType.ApiKey,
                ApiKeyName = LookupKv(Apikey, "key") ?? Key ?? string.Empty,
                ApiKeyValue = LookupKv(Apikey, "value") ?? Value ?? string.Empty,
                ApiKeyIn = string.Equals(LookupKv(Apikey, "in") ?? In, "query", StringComparison.OrdinalIgnoreCase)
                    ? ApiKeyLocation.Query : ApiKeyLocation.Header,
            },
            YamletAuthType.OAuth2 => new()
            {
                Type = YamletAuthType.OAuth2,
                OAuth2 = ParseOAuth2(),
            },
            YamletAuthType.Cookie => new()
            {
                Type = YamletAuthType.Cookie,
                Cookie = Cookie ?? string.Empty,
            },
            YamletAuthType.Inherit => new() { Type = YamletAuthType.Inherit },
            _ => new() { Type = YamletAuthType.None },
        };
    }

    private YamletOAuth2 ParseOAuth2()
    {
        if (Credentials is not null)
        {
            return Credentials.ToDomain();
        }

        var list = Oauth2;
        return new YamletOAuth2
        {
            AccessToken = LookupKv(list, "accessToken") ?? string.Empty,
            HeaderPrefix = LookupKv(list, "tokenType") ?? "Bearer",
            AddTokenTo = string.Equals(LookupKv(list, "addTokenTo"), "queryParams", StringComparison.OrdinalIgnoreCase)
                ? OAuth2TokenLocation.Query : OAuth2TokenLocation.Header,
            AccessTokenUrl = LookupKv(list, "accessTokenUrl") ?? string.Empty,
            AuthUrl = LookupKv(list, "authUrl") ?? string.Empty,
            ClientId = LookupKv(list, "clientId") ?? string.Empty,
            ClientSecret = LookupKv(list, "clientSecret") ?? string.Empty,
            Scope = LookupKv(list, "scope") ?? string.Empty,
            RedirectUri = LookupKv(list, "redirectUri") ?? string.Empty,
            GrantType = (LookupKv(list, "grant_type") ?? "client_credentials").ToLowerInvariant() switch
            {
                "authorization_code" => OAuth2GrantType.AuthorizationCode,
                "password_credentials" => OAuth2GrantType.Password,
                _ => OAuth2GrantType.ClientCredentials,
            },
            ClientAuthentication = string.Equals(LookupKv(list, "client_authentication"), "body", StringComparison.OrdinalIgnoreCase)
                ? OAuth2ClientAuthentication.Body : OAuth2ClientAuthentication.BasicHeader,
            ChallengeAlgorithm = "S256",
        };
    }

    private static string? LookupKv(List<PostmanAuthKvDto>? list, string key) =>
        list?.FirstOrDefault(kv => string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase))?.Value;
}

public sealed class PostmanScriptDto
{
    public string Type { get; set; } = "text/javascript";
    public List<string> Exec { get; set; } = new();
    public string? Id { get; set; }
}

public sealed class PostmanEventDto
{
    public string Listen { get; set; } = string.Empty;
    public PostmanScriptDto Script { get; set; } = new();
}

public sealed class PostmanVariableDto
{
    public string? Id { get; set; }
    public string Key { get; set; } = string.Empty;
    public string? Value { get; set; }
    public string Type { get; set; } = "string";
    public bool? Disabled { get; set; }
}

/// <summary>Postman <c>info</c> block at the top of a collection file.</summary>
public sealed class PostmanInfoDto
{
    [YamlMember(Alias = "_postman_id")]
    public string? PostmanId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string Schema { get; set; } = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
}

/// <summary>
/// Reads <c>collection.yaml</c> in either the native Yamlet flat format (now written by
/// <see cref="CollectionDto"/>) or the legacy Postman v2.1 format. Both shapes are
/// deserialized into the same class; <see cref="ApplyTo"/> prefers Postman fields when
/// present and falls back to the flat ones.
/// </summary>
public sealed class CollectionMetadataDto
{
    // Postman format
    public PostmanInfoDto? Info { get; set; }
    public List<PostmanVariableDto>? Variable { get; set; }
    public List<PostmanEventDto>? Event { get; set; }
    public PostmanAuthDto? Auth { get; set; }

    // Native Yamlet flat format (also the legacy shape written before the Postman era)
    public string? Id { get; set; }
    public string? Name { get; set; }
    public int? Order { get; set; }
    public List<KeyValueDto>? Variables { get; set; }
    public List<ScriptDto>? Scripts { get; set; }

    public void ApplyTo(YamletCollection c)
    {
        var id = Info?.PostmanId ?? Id;
        var name = Info?.Name ?? Name;

        if (!string.IsNullOrWhiteSpace(id)) c.Id = id;
        if (!string.IsNullOrWhiteSpace(name)) c.Name = name;
        if (Order.HasValue) c.Order = Order.Value;

        if (Auth is not null)
        {
            c.Auth = Auth.ToDomain();
        }

        var vars = Variable is { Count: > 0 }
            ? Variable.Select(v => new YamletVariable { Key = v.Key, Value = v.Value ?? string.Empty, Enabled = v.Disabled != true }).ToList()
            : Variables is { Count: > 0 }
                ? Variables.Select(v => new YamletVariable { Key = v.Key, Value = v.Value, Enabled = v.IsEnabled }).ToList()
                : null;
        if (vars is not null) c.Variables = vars;

        var pre = EventScript("prerequest") is { Length: > 0 } p ? p : ScriptDto.JoinByPhase(Scripts, isPre: true);
        var post = EventScript("test") is { Length: > 0 } pt ? pt : ScriptDto.JoinByPhase(Scripts, isPre: false);
        if (!string.IsNullOrEmpty(pre)) c.PreRequestScript = pre;
        if (!string.IsNullOrEmpty(post)) c.PostResponseScript = post;
    }

    private string EventScript(string listen) =>
        Event?.FirstOrDefault(e => string.Equals(e.Listen, listen, StringComparison.OrdinalIgnoreCase)) is { } ev
            ? string.Join("\n", ev.Script.Exec)
            : string.Empty;
}

// ---- Postman Environment Format -----------------------------------------------

public sealed class PostmanEnvironmentValueDto
{
    public string Key { get; set; } = string.Empty;
    public string? Value { get; set; }
    public bool Enabled { get; set; } = true;
    public string Type { get; set; } = "default";
}

/// <summary>
/// On-disk shape for environment YAML files in the Postman v2.1 format. Uses
/// <c>values</c> (not <c>variables</c>) and carries <c>_postman_variable_scope</c>.
/// </summary>
public sealed class PostmanEnvironmentDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<PostmanEnvironmentValueDto> Values { get; set; } = new();

    [YamlMember(Alias = "_postman_variable_scope")]
    public string PostmanVariableScope { get; set; } = "environment";

    public static PostmanEnvironmentDto FromDomain(YamletEnvironment e) => new()
    {
        Id = e.Id,
        Name = e.Name,
        Values = e.Variables
            .Select(v => new PostmanEnvironmentValueDto
            {
                Key = v.Key,
                Value = v.Value,
                Enabled = v.Enabled,
            })
            .ToList(),
    };
}
