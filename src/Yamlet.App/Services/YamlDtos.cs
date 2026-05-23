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
    public bool Enabled { get; set; } = true;
}

public sealed class AuthDto
{
    public string Type { get; set; } = "none";
    public string? Token { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string? Key { get; set; }
    public string? Value { get; set; }
    public string? In { get; set; }

    public static AuthDto FromDomain(YamletAuth a) => new()
    {
        Type = a.Type switch
        {
            YamletAuthType.Bearer => "bearer",
            YamletAuthType.Basic => "basic",
            YamletAuthType.ApiKey => "apikey",
            _ => "none",
        },
        Token = NullIfEmpty(a.Token),
        Username = NullIfEmpty(a.Username),
        Password = NullIfEmpty(a.Password),
        Key = NullIfEmpty(a.ApiKeyName),
        Value = NullIfEmpty(a.ApiKeyValue),
        In = a.Type == YamletAuthType.ApiKey
            ? (a.ApiKeyIn == ApiKeyLocation.Query ? "query" : "header")
            : null,
    };

    public YamletAuth ToDomain() => new()
    {
        Type = (Type ?? "none").ToLowerInvariant() switch
        {
            "bearer" => YamletAuthType.Bearer,
            "basic" => YamletAuthType.Basic,
            "apikey" => YamletAuthType.ApiKey,
            _ => YamletAuthType.None,
        },
        Token = Token ?? string.Empty,
        Username = Username ?? string.Empty,
        Password = Password ?? string.Empty,
        ApiKeyName = Key ?? string.Empty,
        ApiKeyValue = Value ?? string.Empty,
        ApiKeyIn = string.Equals(In, "query", StringComparison.OrdinalIgnoreCase)
            ? ApiKeyLocation.Query
            : ApiKeyLocation.Header,
    };

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
}

public sealed class BodyDto
{
    public string Type { get; set; } = "none";
    public string? Raw { get; set; }

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
        Raw = string.IsNullOrEmpty(b.Raw) ? null : b.Raw,
    };

    public YamletRequestBody ToDomain() => new()
    {
        Type = (Type ?? "none").ToLowerInvariant() switch
        {
            "raw" => YamletBodyType.Raw,
            "json" => YamletBodyType.Json,
            "form-data" => YamletBodyType.FormData,
            "x-www-form-urlencoded" => YamletBodyType.UrlEncoded,
            _ => YamletBodyType.None,
        },
        Raw = Raw ?? string.Empty,
    };
}

/// <summary>On-disk shape of a single request YAML file.</summary>
public sealed class RequestDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;
    public string Method { get; set; } = "GET";
    public string Url { get; set; } = string.Empty;
    public List<KeyValueDto>? QueryParams { get; set; }
    public List<KeyValueDto>? Headers { get; set; }
    public List<KeyValueDto>? PathVariables { get; set; }
    public List<KeyValueDto>? Variables { get; set; }
    public AuthDto? Auth { get; set; }
    public BodyDto? Body { get; set; }

    public static RequestDto FromDomain(YamletRequest r) => new()
    {
        Id = r.Id,
        Name = r.Name,
        Method = r.Method,
        Url = r.Url,
        QueryParams = r.QueryParams.Count == 0 ? null : r.QueryParams
            .Select(p => new KeyValueDto { Key = p.Key, Value = p.Value, Description = NullIfEmpty(p.Description), Enabled = p.Enabled })
            .ToList(),
        Headers = r.Headers.Count == 0 ? null : r.Headers
            .Select(h => new KeyValueDto { Key = h.Key, Value = h.Value, Description = NullIfEmpty(h.Description), Enabled = h.Enabled })
            .ToList(),
        PathVariables = r.PathVariables.Count == 0 ? null : r.PathVariables
            .Select(p => new KeyValueDto { Key = p.Key, Value = p.Value, Description = NullIfEmpty(p.Description), Enabled = true })
            .ToList(),
        Variables = r.Variables.Count == 0 ? null : r.Variables
            .Select(v => new KeyValueDto { Key = v.Key, Value = v.Value, Enabled = v.Enabled })
            .ToList(),
        Auth = AuthDto.FromDomain(r.Auth),
        Body = BodyDto.FromDomain(r.Body),
    };

    public YamletRequest ToDomain(string? sourceFilePath) => new()
    {
        Id = string.IsNullOrWhiteSpace(Id) ? Guid.NewGuid().ToString() : Id,
        Name = Name,
        Method = string.IsNullOrWhiteSpace(Method) ? "GET" : Method.ToUpperInvariant(),
        Url = Url,
        QueryParams = (QueryParams ?? new()).Select(p => new YamletQueryParam
        {
            Key = p.Key, Value = p.Value, Description = p.Description ?? string.Empty, Enabled = p.Enabled,
        }).ToList(),
        Headers = (Headers ?? new()).Select(h => new YamletHeader
        {
            Key = h.Key, Value = h.Value, Description = h.Description ?? string.Empty, Enabled = h.Enabled,
        }).ToList(),
        PathVariables = (PathVariables ?? new()).Select(p => new YamletPathVariable
        {
            Key = p.Key, Value = p.Value, Description = p.Description ?? string.Empty,
        }).ToList(),
        Variables = (Variables ?? new()).Select(v => new YamletVariable
        {
            Key = v.Key, Value = v.Value, Enabled = v.Enabled,
        }).ToList(),
        Auth = (Auth ?? new AuthDto()).ToDomain(),
        Body = (Body ?? new BodyDto()).ToDomain(),
        SourceFilePath = sourceFilePath,
    };

    private static string? NullIfEmpty(string s) => string.IsNullOrEmpty(s) ? null : s;
}

/// <summary>On-disk shape of a <c>collection.yaml</c> metadata file.</summary>
public sealed class CollectionDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;
    public List<KeyValueDto>? Variables { get; set; }

    public static CollectionDto FromDomain(YamletCollection c) => new()
    {
        Id = c.Id,
        Name = c.Name,
        Variables = c.Variables.Count == 0 ? null : c.Variables
            .Select(v => new KeyValueDto { Key = v.Key, Value = v.Value, Enabled = v.Enabled })
            .ToList(),
    };

    public void ApplyTo(YamletCollection c)
    {
        c.Id = string.IsNullOrWhiteSpace(Id) ? c.Id : Id;
        c.Name = Name;
        c.Variables = (Variables ?? new()).Select(v => new YamletVariable
        {
            Key = v.Key, Value = v.Value, Enabled = v.Enabled,
        }).ToList();
    }
}

/// <summary>On-disk shape of an environment YAML file.</summary>
public sealed class EnvironmentDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;
    public List<KeyValueDto>? Variables { get; set; }

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
        Variables = (Variables ?? new()).Select(v => new YamletVariable
        {
            Key = v.Key, Value = v.Value, Enabled = v.Enabled,
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
            Key = v.Key, Value = v.Value, Enabled = v.Enabled,
        }).ToList();
}
