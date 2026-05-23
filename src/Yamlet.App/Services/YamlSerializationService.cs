using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Yamlet.App.Services;

/// <summary>
/// Thin wrapper over YamlDotNet that serializes/deserializes the on-disk DTOs using
/// a consistent camelCase convention. Domain models are never passed here directly;
/// callers map to/from DTOs first so the file format stays decoupled from the UI.
/// </summary>
public sealed class YamlSerializationService
{
    private readonly ISerializer _serializer;
    private readonly IDeserializer _deserializer;

    public YamlSerializationService()
    {
        _serializer = new SerializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .ConfigureDefaultValuesHandling(DefaultValuesHandling.OmitNull)
            .Build();

        _deserializer = new DeserializerBuilder()
            .WithNamingConvention(CamelCaseNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build();
    }

    public string Serialize<T>(T value) => _serializer.Serialize(value);

    public T Deserialize<T>(string yaml) where T : new()
    {
        if (string.IsNullOrWhiteSpace(yaml))
        {
            return new T();
        }

        return _deserializer.Deserialize<T>(yaml) ?? new T();
    }
}
