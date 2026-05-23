using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class YamlSerializationTests
{
    private readonly YamlSerializationService _yaml = new();

    [Fact]
    public void Request_RoundTripsThroughDto()
    {
        var request = new YamletRequest
        {
            Id = "req-1",
            Name = "Get Users",
            Method = "GET",
            Url = "{{baseUrl}}/users",
            QueryParams = { new YamletQueryParam { Key = "page", Value = "1", Description = "Page number", Enabled = true } },
            Headers = { new YamletHeader { Key = "Accept", Value = "application/json", Enabled = true } },
            Auth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "secret" },
            Body = new YamletRequestBody { Type = YamletBodyType.Json, Raw = "{\"a\":1}" },
        };

        var yaml = _yaml.Serialize(RequestDto.FromDomain(request));
        var restored = _yaml.Deserialize<RequestDto>(yaml).ToDomain("/tmp/get-users.yaml");

        Assert.Equal("req-1", restored.Id);
        Assert.Equal("Get Users", restored.Name);
        Assert.Equal("GET", restored.Method);
        Assert.Equal("{{baseUrl}}/users", restored.Url);
        Assert.Single(restored.QueryParams);
        Assert.Equal("page", restored.QueryParams[0].Key);
        Assert.Equal("Page number", restored.QueryParams[0].Description);
        Assert.Single(restored.Headers);
        Assert.Equal("Accept", restored.Headers[0].Key);
        Assert.Equal(YamletAuthType.Bearer, restored.Auth.Type);
        Assert.Equal("secret", restored.Auth.Token);
        Assert.Equal(YamletBodyType.Json, restored.Body.Type);
        Assert.Equal("{\"a\":1}", restored.Body.Raw);
        Assert.Equal("/tmp/get-users.yaml", restored.SourceFilePath);
    }

    [Fact]
    public void RequestYaml_UsesCamelCaseAndLowercaseEnums()
    {
        var request = new YamletRequest
        {
            Name = "Sample",
            Method = "POST",
            Auth = new YamletAuth { Type = YamletAuthType.None },
            Body = new YamletRequestBody { Type = YamletBodyType.None },
            QueryParams = { new YamletQueryParam { Key = "q", Value = "1", Enabled = true } },
        };

        var yaml = _yaml.Serialize(RequestDto.FromDomain(request));

        Assert.Contains("queryParams:", yaml);
        Assert.Contains("type: noauth", yaml);
    }

    [Fact]
    public void RequestYaml_OmitsAuthWhenRequestInherits()
    {
        var request = new YamletRequest
        {
            Name = "Sample",
            Method = "GET",
            Url = "https://api.example.com",
        };

        var yaml = _yaml.Serialize(RequestDto.FromDomain(request));
        var restored = _yaml.Deserialize<RequestDto>(yaml).ToDomain("/tmp/sample.yaml");

        Assert.DoesNotContain("auth:", yaml);
        Assert.Equal(YamletAuthType.Inherit, restored.Auth.Type);
    }

    [Fact]
    public void Collection_RoundTrips()
    {
        var collection = new YamletCollection
        {
            Id = "col-1",
            Name = "My API",
            Auth = new YamletAuth { Type = YamletAuthType.Bearer, Token = "{{token}}" },
            Variables = { new YamletVariable { Key = "baseUrl", Value = "https://api.example.com", Enabled = true } },
        };

        var yaml = _yaml.Serialize(CollectionDto.FromDomain(collection));
        var dto = _yaml.Deserialize<CollectionDto>(yaml);
        var restored = new YamletCollection();
        dto.ApplyTo(restored);

        Assert.Equal("col-1", restored.Id);
        Assert.Equal("My API", restored.Name);
        Assert.Equal(YamletAuthType.Bearer, restored.Auth.Type);
        Assert.Equal("{{token}}", restored.Auth.Token);
        Assert.Single(restored.Variables);
        Assert.Equal("baseUrl", restored.Variables[0].Key);
    }

    [Fact]
    public void Environment_RoundTrips()
    {
        var env = new YamletEnvironment
        {
            Id = "env-1",
            Name = "Local",
            Variables = { new YamletVariable { Key = "baseUrl", Value = "http://localhost:5000", Enabled = true } },
        };

        var yaml = _yaml.Serialize(EnvironmentDto.FromDomain(env));
        var restored = _yaml.Deserialize<EnvironmentDto>(yaml).ToDomain(null);

        Assert.Equal("Local", restored.Name);
        Assert.Equal("http://localhost:5000", restored.Variables[0].Value);
    }

    [Fact]
    public void Deserialize_EmptyStringYieldsDefault()
    {
        var dto = _yaml.Deserialize<RequestDto>("");
        Assert.NotNull(dto);
        Assert.Equal("GET", dto.Method);
    }

    [Fact]
    public void ApiKeyAuth_RoundTripsLocation()
    {
        var auth = new YamletAuth
        {
            Type = YamletAuthType.ApiKey,
            ApiKeyName = "X-Api-Key",
            ApiKeyValue = "k",
            ApiKeyIn = ApiKeyLocation.Query,
        };

        var restored = AuthDto.FromDomain(auth).ToDomain();

        Assert.Equal(YamletAuthType.ApiKey, restored.Type);
        Assert.Equal(ApiKeyLocation.Query, restored.ApiKeyIn);
        Assert.Equal("X-Api-Key", restored.ApiKeyName);
    }

    [Fact]
    public void CookieAuth_RoundTrips()
    {
        var auth = new YamletAuth
        {
            Type = YamletAuthType.Cookie,
            Cookie = "session={{sessionId}}",
        };

        var restored = AuthDto.FromDomain(auth).ToDomain();

        Assert.Equal(YamletAuthType.Cookie, restored.Type);
        Assert.Equal("session={{sessionId}}", restored.Cookie);
    }
}
